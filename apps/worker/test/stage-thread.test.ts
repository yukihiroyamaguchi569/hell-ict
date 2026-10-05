import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { chatSnapshotSchema, stageAiSchema } from "@hell-ict/domain";
import type { ChatSnapshot } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { handleGameState, handlePrepareStageThread } from "../src/game-api.js";
import { MAX_STAGE_THREADS_PER_TEAM } from "../src/chat-store.js";
import {
  advance,
  applied,
  CLEAR,
  playTo,
  postCommand,
  replySchema,
  send,
} from "./game-command-support.js";
import { clock, gameOf, gmReset, viewSchema } from "./game-support.js";
import { get, postJson, TEST_ORIGIN } from "./support.js";

/**
 * ステージに入ったときの会話の用意（Issue #236）と、用意できなかったときの扱い（Issue #85）。
 * クライアントはスレッドを作らない。サーバが前進の適用と同時にステージの会話を作り、
 * GETとコマンドの応答の`ai`で「今のステージの会話はどれか」を示す。
 */

beforeEach(() => {
  clock.reset();
});

const withAi = viewSchema.extend({ ai: stageAiSchema });

const aiOf = async (teamCode: string) => {
  const response = await handleGameState(env, teamCode, clock);
  expect(response.status).toBe(200);
  return withAi.parse(await response.json()).ai;
};

/** 適用されたコマンドの応答を、`ai`ごと読む（replySchemaは`ai`を落とす）。 */
const appliedWithAi = async (teamCode: string, body: unknown) => {
  const response = await postCommand(teamCode, body);
  expect(response.status).toBe(200);
  const reply = withAi.extend(replySchema.shape).parse(await response.json());
  expect(reply.status).toBe("applied");
  return reply;
};

const chatOf = async (teamCode: string): Promise<ChatSnapshot> => {
  const response = await get(`/api/teams/${teamCode}/chat`);
  expect(response.status).toBe(200);
  return chatSnapshotSchema.parse(await response.json());
};

const stageThreads = async (teamCode: string) =>
  (await chatOf(teamCode)).threads.filter((thread) => thread.kind === "stage");

const prepare = (teamCode: string, generation = 0): Promise<Response> =>
  handlePrepareStageThread(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/thread`, {
      method: "POST",
      body: JSON.stringify({ type: "prepare-stage-thread", generation }),
    }),
    env,
    teamCode,
    clock,
  );

/** 旧経路（モック）のスレッド作成。ステージ用の枠を埋めるのに使う。 */
const legacyStageThread = async (teamCode: string, title: string): Promise<void> => {
  const response = await postJson(`/api/teams/${teamCode}/chat/threads`, {
    type: "create-thread",
    commandId: crypto.randomUUID(),
    title,
    kind: "stage",
    generation: 0,
  });
  expect(response.status).toBe(200);
};

const readChatState = (teamCode: string): Promise<string> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) =>
    String(state.storage.sql.exec("SELECT snapshot FROM chat_state WHERE id = 1").one().snapshot),
  );

const writeChatState = (teamCode: string, snapshot: string): Promise<void> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
    state.storage.sql.exec("UPDATE chat_state SET snapshot = ? WHERE id = 1", snapshot);
  });

describe("ステージに入るとサーバが会話を用意する", () => {
  it("Prologue はAIが無く、Stage 1 はメインの会話を使う", async () => {
    const teamCode = "860001";
    expect(await aiOf(teamCode)).toEqual({ status: "none" });
    await playTo(teamCode, "s1");
    const main = (await chatOf(teamCode)).threads[0];
    expect(await aiOf(teamCode)).toEqual({ status: "ready", threadId: main?.threadId, live: true });
    expect(await stageThreads(teamCode)).toEqual([]);
  });

  it("Stage 2〜6 はそれぞれ自分の会話を持ち、前進の応答とGETの両方がその会話を示す", async () => {
    const teamCode = "860002";
    await playTo(teamCode, "s2");
    const expected = [
      ["s2", "Stage 2", false],
      ["s3", "Stage 3", true],
      ["s4", "Stage 4", true],
      ["s5", "Stage 5", true],
      ["s6", "Stage 6", false],
    ] as const;
    for (const [index, [stage, title, live]] of expected.entries()) {
      if (index > 0) {
        const previous = expected[index - 1]?.[0] ?? "s1";
        await CLEAR[previous]?.(teamCode);
        clock.advanceBy(5_000);
        const reply = await appliedWithAi(teamCode, advance(previous, stage));
        expect(reply.ai).toMatchObject({ status: "ready", live });
      }
      const thread = (await stageThreads(teamCode)).find((candidate) => candidate.title === title);
      expect(await aiOf(teamCode)).toEqual({ status: "ready", threadId: thread?.threadId, live });
    }
    expect((await stageThreads(teamCode)).map((thread) => thread.title)).toEqual(
      expected.map(([, title]) => title),
    );
    await CLEAR.s6?.(teamCode);
    clock.advanceBy(5_000);
    await applied(teamCode, advance("s6", "final"));
    expect(await aiOf(teamCode)).toEqual({ status: "none" });
    expect(await stageThreads(teamCode)).toHaveLength(5);
  });

  it("前進の再送は会話を増やさない", async () => {
    const teamCode = "860003";
    await playTo(teamCode, "s1");
    await CLEAR.s1?.(teamCode);
    const command = advance("s1", "s2");
    await applied(teamCode, command);
    expect((await send(teamCode, command)).status).toBe("duplicate");
    expect((await send(teamCode, command)).status).toBe("duplicate");
    expect(await stageThreads(teamCode)).toHaveLength(1);
  });

  it("旧経路（モック）が同じステージの会話を先に作っていれば、それを使う", async () => {
    const teamCode = "860004";
    await playTo(teamCode, "s1");
    await CLEAR.s1?.(teamCode);
    await legacyStageThread(teamCode, "Stage 2");
    const [existing] = await stageThreads(teamCode);
    await applied(teamCode, advance("s1", "s2"));
    expect(await stageThreads(teamCode)).toHaveLength(1);
    expect(await aiOf(teamCode)).toEqual({
      status: "ready",
      threadId: existing?.threadId,
      live: false,
    });
  });
});

describe("会話を用意できなかったとき（Issue #85）", () => {
  it("前進は成立し、前のステージの会話を示さずに失敗を示す。やり直せば用意できる", async () => {
    const teamCode = "870001";
    await playTo(teamCode, "s2");
    await CLEAR.s2?.(teamCode);
    expect(await aiOf(teamCode)).toMatchObject({ status: "ready" });
    // 会話のsnapshotを読めない状態で前進する。
    const saved = await readChatState(teamCode);
    await writeChatState(teamCode, "{broken");
    const reply = await appliedWithAi(teamCode, advance("s2", "s3"));
    expect(reply.state.game.stage).toBe("s3");
    expect(reply.ai).toEqual({ status: "failed" });
    // 読めるようになっても、Stage 3 の会話が無いうちは失敗を示し続ける（Stage 2 の会話を出さない）。
    await writeChatState(teamCode, saved);
    expect(await aiOf(teamCode)).toEqual({ status: "failed" });
    // やり直し。
    const retried = await prepare(teamCode);
    expect(retried.status).toBe(200);
    const view = withAi.parse(await retried.json());
    const stage3 = (await stageThreads(teamCode)).find((thread) => thread.title === "Stage 3");
    expect(view.ai).toEqual({ status: "ready", threadId: stage3?.threadId, live: true });
    expect(await aiOf(teamCode)).toEqual(view.ai);
    // もう一度やり直しても増えない。
    expect((await prepare(teamCode)).status).toBe(200);
    expect(await stageThreads(teamCode)).toHaveLength(2);
  });

  it("ステージ用の枠が尽きていれば失敗を示し、やり直しても増やさない", async () => {
    const teamCode = "870002";
    await playTo(teamCode, "s1");
    await CLEAR.s1?.(teamCode);
    for (let i = 0; i < MAX_STAGE_THREADS_PER_TEAM; i += 1) {
      await legacyStageThread(teamCode, `別の会話${String(i)}`);
    }
    const reply = await appliedWithAi(teamCode, advance("s1", "s2"));
    expect(reply.ai).toEqual({ status: "failed" });
    const retried = withAi.parse(await (await prepare(teamCode)).json());
    expect(retried.ai).toEqual({ status: "failed" });
    expect(await stageThreads(teamCode)).toHaveLength(MAX_STAGE_THREADS_PER_TEAM);
  });

  it("会話を持たないステージでのやり直しは何も作らない", async () => {
    const teamCode = "870003";
    await playTo(teamCode, "s1");
    const view = withAi.parse(await (await prepare(teamCode)).json());
    expect(view.ai).toMatchObject({ status: "ready", live: true });
    expect(await stageThreads(teamCode)).toEqual([]);
  });
});

describe("やり直しの経路", () => {
  it("POST /game/chat/thread で呼べる", async () => {
    const response = await postJson("/api/teams/880001/game/chat/thread", {
      type: "prepare-stage-thread",
      generation: 0,
    });
    expect(response.status).toBe(200);
    expect(withAi.parse(await response.json()).ai).toEqual({ status: "none" });
  });

  it("形の違う本文は400", async () => {
    for (const body of [{}, { type: "prepare-stage-thread", generation: "0" }, { type: "x" }]) {
      const response = await postJson("/api/teams/880002/game/chat/thread", body);
      expect(response.status).toBe(400);
    }
  });

  it("GMリセットより前の世代は409で、リセット後のチームに会話を作らない", async () => {
    const teamCode = "880003";
    await playTo(teamCode, "s2");
    expect((await gmReset(teamCode)).status).toBe(200);
    const response = await prepare(teamCode, 0);
    expect(response.status).toBe(409);
    expect(z.object({ code: z.string() }).parse(await response.json()).code).toBe(
      "stale-generation",
    );
    expect(await stageThreads(teamCode)).toEqual([]);
    expect((await gameOf(teamCode)).state.game.stage).toBe("prologue");
  });
});
