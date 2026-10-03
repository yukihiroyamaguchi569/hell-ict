import type { Page } from "@playwright/test";

import {
  gameCommandResponseSchema,
  gameViewResponseSchema,
  isS6PromptCopiedFromMail,
  judgeS6Submission,
  redactPii,
  selectS6PosterType,
  type S6PosterType,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";

/*
 * Stage 6 のチームを、page.route の固定応答で動かす道具。入室（/api/session）と疎通確認は本物の
 * Worker、`GET /game` と `POST .../game/commands` をここで差し替える。生成と提出の判定は domain の
 * 関数そのもので行い、応答は画面と同じ schema に通してから返す。
 */

export interface FakeStage6 {
  readonly promptLog: string[];
  readonly candidates: S6PosterType[];
  cleared: boolean;
  /** Past Stage 6 (`advance` applied): the team is in the Final. */
  advanced: boolean;
  /** Every command the screen posted, in order. */
  readonly commands: Record<string, unknown>[];
  /** Commands Stage 6 must never send. Answered 500; the spec checks this stays empty. */
  readonly unexpected: Record<string, unknown>[];
  /** Every request to the server's AI chat (`/game/chat/...`): Stage 6 must send none. */
  readonly chatRequests: string[];
  /**
   * Holds the next `s6.generate` until the returned function is called: then it is applied (a
   * send that lands late) and answered, if its page is still there to take the answer.
   */
  holdNextGenerate(): () => void;
  /** The held send has been let go and answered (to its page or to nowhere). */
  heldAnswered: boolean;
}

const bodyOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...value } : {};

export const fakeStage6 = async (page: Page): Promise<FakeStage6> => {
  const base = serverNow();
  const fake: FakeStage6 = {
    promptLog: [],
    candidates: [],
    cleared: false,
    advanced: false,
    commands: [],
    unexpected: [],
    chatRequests: [],
    holdNextGenerate: () => {
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    heldAnswered: false,
  };
  let hold: Promise<void> | null = null;
  /** The generations applied, by commandId: a send again under one comes back `duplicate`. */
  const generated = new Map<string, { index: number; type: S6PosterType }>();

  const view = () => {
    if (fake.advanced) {
      const final = gameView("final", false, base);
      const enteredAt = { ...final.state.enteredAt, final: new Date(base).toISOString() };
      return { ...final, state: { ...final.state, enteredAt }, serverNow: serverNow() };
    }
    const shown = gameView("s6", fake.cleared, base);
    return gameViewResponseSchema.parse({
      ...shown,
      state: {
        ...shown.state,
        s6: { promptLog: [...fake.promptLog], candidates: [...fake.candidates] },
      },
      serverNow: serverNow(),
    });
  };

  const generate = (prompt: string, commandId: string): unknown => {
    const first = generated.get(commandId);
    if (first !== undefined) {
      return { status: "duplicate", original: { events: [], judgement: first }, ...view() };
    }
    if (isS6PromptCopiedFromMail(prompt)) {
      return { status: "rejected", reason: "copied-from-mail", ...view() };
    }
    const type = selectS6PosterType(prompt, fake.candidates.at(-1) ?? null);
    const index = fake.candidates.length;
    fake.promptLog.push(redactPii(prompt));
    fake.candidates.push(type);
    generated.set(commandId, { index, type });
    return { status: "applied", events: [], judgement: { index, type }, ...view() };
  };

  const submit = (index: number): unknown => {
    const type = fake.candidates[index];
    if (type === undefined) return null;
    const judgement = judgeS6Submission(type, fake.promptLog);
    if (judgement.outcome === "pass") fake.cleared = true;
    return { status: "applied", events: [], judgement, ...view() };
  };

  const isAdvanceOutOfStage6 = (body: Record<string, unknown>): boolean =>
    body.type === "advance" && body.from === "s6" && body.to === "final";

  const answer = (body: Record<string, unknown>): unknown => {
    if (fake.cleared) {
      // Only the clear effect's advance out of a cleared Stage 6 is expected after the clear.
      if (!isAdvanceOutOfStage6(body)) return null;
      fake.advanced = true;
      return { status: "applied", events: [], judgement: null, ...view() };
    }
    if (body.type === "s6.generate") return generate(String(body.prompt), String(body.commandId));
    if (body.type === "s6.submit") return submit(Number(body.candidateIndex));
    return null;
  };

  page.on("request", (request) => {
    if (request.url().includes("/game/chat/")) fake.chatRequests.push(request.url());
  });
  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const body = bodyOf(route.request().postDataJSON());
    fake.commands.push(body);
    const held = body.type === "s6.generate" ? hold : null;
    if (held !== null) {
      hold = null;
      await held;
    }
    const answered = answer(body);
    if (answered === null) {
      fake.unexpected.push(body);
      await route.fulfill({ status: 500, json: { message: "unexpected command" } });
      return;
    }
    const json = gameCommandResponseSchema.parse(answered);
    // A held send may outlive its page (reloaded meanwhile): its answer then goes nowhere.
    await route.fulfill({ json }).catch(() => undefined);
    if (held !== null) fake.heldAnswered = true;
  });
  return fake;
};
