import type { Page } from "@playwright/test";

import { stage2SheetRows } from "../../packages/content/src/index.js";
import {
  gameCommandResponseSchema,
  gameInstantSchema,
  gameViewResponseSchema,
  judgeStage2,
  normalizeStage2Rows,
  takeStage2Addendum,
  teamGameCommandSchema,
  type Stage2Grid,
  type Stage2Row,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";

/*
 * Stage 2 の Worker の代わり。`GET /api/teams/:code/game` とコマンドを page.route で受け、判定は
 * domain の judgeStage2 をそのまま使う（画面と同じ schema に通して返す）。入室（/api/session）と
 * 疎通確認は本物の Worker。時刻はすべてサーバの時計（serverNow）で持つ。
 */

type View = ReturnType<typeof gameView>;
type State = View["state"];

export interface FakeStage2 {
  readonly state: () => State;
  /** Every command the screen posted, by type, in order. */
  readonly types: string[];
}

const applied = (state: State, view: View, judgement: unknown, events: unknown[] = []) =>
  gameCommandResponseSchema.parse({
    status: "applied",
    events,
    judgement,
    state,
    pos: view.pos,
    serverNow: serverNow(),
    ai: view.ai,
  });

/**
 * A team in Stage 2 whose stage started `startedAgoMs` ago by the server's clock, or has not
 * started yet (`null`: the screen sends `s2.start`). `ai` is the stage AI `GET /game` reports
 * (`failed`: the server could not prepare the stage's conversation).
 */
export const fakeStage2 = async (
  page: Page,
  startedAgoMs: number | null,
  ai: View["ai"] = { status: "none" },
): Promise<FakeStage2> => {
  const base = serverNow();
  let view: View = { ...gameView("s2", false, base), ai };
  let state: State = {
    ...view.state,
    s2: startedAgoMs === null ? null : { startedAt: base - startedAgoMs, addendumTakenAt: null },
  };
  const types: string[] = [];

  const answer = (body: unknown) => {
    const command = teamGameCommandSchema.parse(body);
    types.push(command.type);
    const now = serverNow();
    if (command.type === "s2.start") {
      state = { ...state, s2: { startedAt: now, addendumTakenAt: null } };
      return applied(state, view, null);
    }
    if (command.type === "s2.take-addendum" && state.s2 !== null) {
      const taken = takeStage2Addendum(state.s2, [], [], now);
      state = { ...state, s2: taken.state };
      return applied(state, view, taken.judgement);
    }
    if (command.type === "s2.submit" && state.s2 !== null) {
      const judgement = judgeStage2(command.grid, state.s2, now);
      if (judgement.outcome === "pass") {
        const s2 = gameInstantSchema.parse(new Date(now).toISOString());
        const clearedAt = { ...state.game.clearedAt, s2 };
        state = { ...state, game: { ...state.game, clearedAt } };
        view = { ...view, pos: view.pos + 1 };
      }
      return applied(state, view, judgement);
    }
    if (command.type === "advance") {
      const next = gameView("s3", false, base);
      state = next.state;
      view = next;
      const entered = { type: "stage-entered", stage: "s3", at: new Date(now).toISOString() };
      return applied(state, view, null, [entered]);
    }
    throw new Error(`unexpected command ${command.type}`);
  };

  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({
      json: gameViewResponseSchema.parse({ ...view, state, serverNow: serverNow() }),
    });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    await route.fulfill({ json: answer(route.request().postDataJSON()) });
  });
  return { state: () => state, types };
};

/** The model answer of the delivered sheet: 20 rows, the noise rows gone (what the AI makes). */
export const modelGrid = (): Stage2Grid =>
  normalizeStage2Rows(stage2SheetRows.map((row): Stage2Row => [...row]));
