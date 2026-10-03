import type { Page, Request } from "@playwright/test";

import {
  chatSnapshotSchema,
  detectPii,
  gameCommandResponseSchema,
  gameInstantSchema,
  gameStagePosition,
  gameViewResponseSchema,
  judgeS5Report,
  judgeS5Submission,
  STAGE5_DEADLINE_MS,
  type PenaltyStatus,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";
import { SAVED_TEAM_CODE_KEY } from "../shell/helpers";

/*
 * Stage 5 のチームを受け持つ偽のサーバ。入室と疎通確認は本物の Worker、`GET /game`・
 * `POST .../game/commands`・右ペインの `GET /chat` と `POST .../game/chat/messages` を page.route で
 * 差し替える。判定は domain の judgeS5Submission・judgeS5Report そのもの。AIへの送信は Worker と
 * 同じく detectPii で見分け、個人情報があれば 422 pii_blocked で止め、初回だけ罰を始める
 * （s5.check-ai-message を適用した後の状態）。本文は会話に残さない。受け付けるコマンドは
 * 罰の外の s5.submit、罰の間の s5.submit-report、クリア後の advance {s5→s6} だけで、
 * それ以外（画面が送ってはいけない s5.check-ai-message を含む）は `unexpected` に残して 500 を返す。
 */

export const S5_THREAD = "55555555-5555-4555-8555-555555555555";

export interface FakeStage5 {
  penalty: PenaltyStatus;
  cleared: boolean;
  /** Every command the screen posted, in order. */
  readonly commands: Record<string, unknown>[];
  /** Commands the screen should never have sent at that moment (answered 500). Must stay empty. */
  readonly unexpected: Record<string, unknown>[];
  /** Every text posted to the stage AI, in order (PII included: it never goes further). */
  readonly chatPosts: string[];
  count(type: string): number;
}

export interface FakeStage5Options {
  /** How long before the fake's start the team entered Stage 5 (the deadline is 2 minutes). */
  readonly enteredAgoMs?: number;
  readonly penalty?: PenaltyStatus;
  /**
   * The deadline falls this long after the trap's first firing, whenever that is: the entry is
   * moved back when the trap fires, so a slow page can never bring the deadline before the trap.
   */
  readonly deadlineAfterTrapMs?: number;
}

type Body = Record<string, unknown>;

const bodyOf = (request: Request): Body => {
  const body: unknown = request.postDataJSON();
  return typeof body === "object" && body !== null ? { ...body } : {};
};

const at = () => gameInstantSchema.parse(new Date(serverNow()).toISOString());

const isChatGet = (url: URL): boolean => /^\/api\/teams\/\d{6}\/chat$/.test(url.pathname);

export const fakeStage5 = async (
  page: Page,
  teamCode: string,
  options: FakeStage5Options = {},
): Promise<FakeStage5> => {
  const base = serverNow();
  const enteredBefore = (ms: number) =>
    gameInstantSchema.parse(new Date(serverNow() - ms).toISOString());
  let enteredAt = enteredBefore(options.enteredAgoMs ?? 0);
  const clearedAt = at();
  const messages: {
    messageId: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
  }[] = [];
  let revision = 1;
  const fake: FakeStage5 = {
    penalty: options.penalty ?? "none",
    cleared: false,
    commands: [],
    unexpected: [],
    chatPosts: [],
    count: (type) => fake.commands.filter((c) => c.type === type).length,
  };

  const view = () => {
    const shown = gameView("s5", fake.cleared, base);
    const { state } = shown;
    return gameViewResponseSchema.parse({
      ...shown,
      state: {
        ...state,
        game: {
          ...state.game,
          clearedAt: fake.cleared
            ? { ...state.game.clearedAt, s5: clearedAt }
            : state.game.clearedAt,
          penalties: { ...state.game.penalties, s5: fake.penalty },
        },
        enteredAt: { ...state.enteredAt, s5: enteredAt },
      },
      pos: gameStagePosition("s5") + (fake.cleared ? 1 : 0),
      serverNow: serverNow(),
      ai: { status: "ready", threadId: S5_THREAD, live: true },
    });
  };

  const snapshot = () =>
    chatSnapshotSchema.parse({
      teamCode,
      revision,
      threads: [{ threadId: S5_THREAD, title: "Stage 5", kind: "stage", messages }],
    });

  const addMessage = (role: "user" | "assistant", text: string) => {
    const seq = messages.length + 1;
    const message = {
      messageId: `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`,
      role,
      text,
      createdAt: new Date(Date.UTC(2026, 9, 31, 1, 0, seq)).toISOString(),
    };
    messages.push(message);
    return message;
  };

  const submit = (body: Body) => {
    const judgement = judgeS5Submission(String(body.text));
    if (judgement.outcome === "pass") fake.cleared = true;
    return { status: "applied", events: [], judgement, ...view() };
  };

  const submitReport = (body: Body) => {
    const indices = Array.isArray(body.maskedIndices) ? body.maskedIndices.map(Number) : [];
    const judgement = judgeS5Report(indices);
    if (judgement.outcome === "reject") {
      return { status: "rejected", reason: "report-incomplete", judgement, ...view() };
    }
    fake.penalty = "done";
    return { status: "applied", events: [], judgement, ...view() };
  };

  const isAdvanceOutOfStage5 = (body: Body): boolean =>
    body.type === "advance" && body.from === "s5" && body.to === "s6";

  /** The answer to a command the screen may send now, or `null` for one it never should. */
  const handle = (body: Body): unknown => {
    const running = fake.penalty === "in-progress";
    if (body.type === "s5.submit" && !running && !fake.cleared) return submit(body);
    if (body.type === "s5.submit-report" && running) return submitReport(body);
    if (isAdvanceOutOfStage5(body) && fake.cleared) {
      return { status: "applied", events: [], judgement: null, ...view() };
    }
    return null;
  };

  const answered = new Map<string, { events: unknown; judgement: unknown }>();

  await page.addInitScript(
    ([key, code]) => {
      localStorage.setItem(key, code);
    },
    [SAVED_TEAM_CODE_KEY, teamCode] as const,
  );
  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const body = bodyOf(route.request());
    fake.commands.push(body);
    const id = String(body.commandId);
    const first = answered.get(id);
    if (first !== undefined) {
      const json = { status: "duplicate", original: first, ...view() };
      await route.fulfill({ json: gameCommandResponseSchema.parse(json) });
      return;
    }
    const json = handle(body);
    if (json === null) {
      fake.unexpected.push(body);
      await route.fulfill({ status: 500, json: { message: "unexpected command" } });
      return;
    }
    const parsed = gameCommandResponseSchema.parse(json);
    if (parsed.status === "applied") {
      answered.set(id, { events: parsed.events, judgement: parsed.judgement });
    }
    await route.fulfill({ json: parsed });
  });
  await page.route(isChatGet, async (route) => {
    await route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/teams/*/game/chat/messages", async (route) => {
    const text = String(bodyOf(route.request()).text);
    fake.chatPosts.push(text);
    if (detectPii(text) !== null) {
      // The Worker applies s5.check-ai-message: the trap's first firing starts the penalty.
      if (fake.penalty === "none") {
        fake.penalty = "in-progress";
        const after = options.deadlineAfterTrapMs;
        if (after !== undefined) enteredAt = enteredBefore(STAGE5_DEADLINE_MS - after);
      }
      await route.fulfill({
        status: 422,
        json: { message: "個人情報を検知したため、送信をブロックしました。", code: "pii_blocked" },
      });
      return;
    }
    addMessage("user", text);
    const assistant = addMessage("assistant", `回答: ${text}`);
    revision += 1;
    await route.fulfill({ json: { snapshot: snapshot(), assistant } });
  });
  return fake;
};
