import type { Page } from "@playwright/test";

import {
  gameCommandResponseSchema,
  gameViewResponseSchema,
  judgeStage4Action,
  judgeStage4Summary,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";

/*
 * Stage 4 のチームを、page.route の固定応答で動かす道具。入室（/api/session）と疎通確認は本物の
 * Worker、`GET /game` と `POST .../game/commands` をここで差し替える。判定は domain の判定関数
 * そのもので行い、応答は画面と同じ schema に通してから返す。
 */

export interface FakeStage4 {
  accepted: boolean;
  cleared: boolean;
  /** Past Stage 4 (`advance` applied): the team is in Stage 5. */
  advanced: boolean;
  /** Every command the screen posted, in order. */
  readonly commands: Record<string, unknown>[];
  /**
   * Commands Stage 4 must never send (anything but its two submissions and the advance out of a
   * cleared Stage 4). Answered 500; the spec checks this stays empty after every test.
   */
  readonly unexpected: Record<string, unknown>[];
}

const bodyOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...value } : {};

const isAdvanceOutOfStage4 = (body: Record<string, unknown>): boolean =>
  body.type === "advance" && body.from === "s4" && body.to === "s5";

export const fakeStage4 = async (page: Page): Promise<FakeStage4> => {
  const base = serverNow();
  const fake: FakeStage4 = {
    accepted: false,
    cleared: false,
    advanced: false,
    commands: [],
    unexpected: [],
  };

  const view = () => {
    if (fake.advanced) return { ...gameView("s5", false, base), serverNow: serverNow() };
    const shown = gameView("s4", fake.cleared, base);
    return gameViewResponseSchema.parse({
      ...shown,
      state: { ...shown.state, s4: { summaryAccepted: fake.accepted } },
      serverNow: serverNow(),
    });
  };

  const answer = (body: Record<string, unknown>): unknown => {
    const text = String(body.text);
    if (body.type === "s4.submit-summary") {
      const judgement = judgeStage4Summary(text);
      if (judgement.outcome === "reject") {
        return { status: "rejected", reason: judgement.reason, judgement, ...view() };
      }
      fake.accepted = true;
      return { status: "applied", events: [], judgement, ...view() };
    }
    if (body.type === "s4.submit-action") {
      const judgement = judgeStage4Action(text);
      if (judgement.outcome === "pass") fake.cleared = true;
      return { status: "applied", events: [], judgement, ...view() };
    }
    // Only the clear effect's advance out of a cleared Stage 4 is expected besides the two above.
    if (isAdvanceOutOfStage4(body) && fake.cleared) {
      fake.advanced = true;
      return { status: "applied", events: [], judgement: null, ...view() };
    }
    return null;
  };

  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const body = bodyOf(route.request().postDataJSON());
    fake.commands.push(body);
    const answered = answer(body);
    if (answered === null) {
      fake.unexpected.push(body);
      await route.fulfill({ status: 500, json: { message: "unexpected command" } });
      return;
    }
    await route.fulfill({ json: gameCommandResponseSchema.parse(answered) });
  });
  return fake;
};
