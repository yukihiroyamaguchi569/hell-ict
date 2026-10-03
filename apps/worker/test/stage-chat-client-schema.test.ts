import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import {
  chatMessageResultSchema,
  chatSnapshotSchema,
  gameViewResponseSchema,
  httpErrorSchema,
} from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import { beforeEach, describe, expect, it } from "vitest";

import { handlePrepareStageThread } from "../src/game-api.js";
import { handleStageChatMessage } from "../src/stage-chat.js";
import { playTo } from "./game-command-support.js";
import { clock } from "./game-support.js";
import { get, TEST_ORIGIN } from "./support.js";
import { PII_NAME } from "./pii-support.js";

beforeEach(() => {
  clock.reset();
});

/**
 * 画面（apps/web の api/chat-api.ts・game-api.ts）は、ステージのAIチャットの応答を domain の
 * schema で検証してから使う。Worker の実際の応答がそのschemaを通ることを、画面が踏む順
 * （送信 → 取り直し → 再入室の突き合わせ → 会話の準備のやり直し）で往復して固定する——
 * 片方だけ形を変えると、画面は全応答を不正として捨て、送信のたびに「応答を取得できません」になる。
 */

const post = async (teamCode: string, body: unknown, aiGateway: FakeAiGateway) => {
  const ctx = createExecutionContext();
  const response = await handleStageChatMessage(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { env, ctx },
    teamCode,
    { aiGateway, nowMs: clock.now().getTime() },
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const message = (text: string, commandId: string = crypto.randomUUID()) => ({
  type: "stage-message",
  commandId,
  generation: 0,
  text,
});

const prepare = (teamCode: string) =>
  handlePrepareStageThread(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/thread`, {
      method: "POST",
      body: JSON.stringify({ type: "prepare-stage-thread", generation: 0 }),
    }),
    env,
    teamCode,
    clock,
  );

describe("ステージのAIチャットの応答は画面のschemaを通る", () => {
  it("送信の200、GET /chat（commandIds あり・なし）、会話の準備の200", async () => {
    const teamCode = "660001";
    await playTo(teamCode, "s3");
    const commandId = crypto.randomUUID();
    const gateway = new FakeAiGateway([{ kind: "success", response: "氏名\t体温\nA\t38.1" }]);

    const sent = await post(teamCode, message("整形して", commandId), gateway);
    expect(sent.status).toBe(200);
    const result = chatMessageResultSchema.parse(await sent.json());
    // タブを含む応答もそのまま返る（画面は TSV として描く）。
    expect(result.assistant.text).toBe("氏名\t体温\nA\t38.1");

    const plain = chatSnapshotSchema.parse(await (await get(`/api/teams/${teamCode}/chat`)).json());
    expect(plain.commands).toBeUndefined();
    expect(plain.revision).toBeGreaterThanOrEqual(result.snapshot.revision);

    const unknownId = crypto.randomUUID();
    const asked = await get(`/api/teams/${teamCode}/chat?commandIds=${commandId},${unknownId}`);
    expect(asked.status).toBe(200);
    const reconciled = chatSnapshotSchema.parse(await asked.json());
    expect(reconciled.commands).toEqual({ [commandId]: "processed", [unknownId]: "unknown" });

    const prepared = await prepare(teamCode);
    expect(prepared.status).toBe(200);
    const view = gameViewResponseSchema.parse(await prepared.json());
    expect(view.ai.status).toBe("ready");
    // 画面は ai.threadId の会話だけを描く。送った会話はそのスレッドにある。
    const threadId = view.ai.status === "ready" ? view.ai.threadId : null;
    const thread = reconciled.threads.find((candidate) => candidate.threadId === threadId);
    expect(thread?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("拒否の本文（422 pii_blocked・409 no_ai_chat）は画面のエラーschemaを通り、code が読める", async () => {
    const teamCode = "660002";
    await playTo(teamCode, "s5");
    const gateway = new FakeAiGateway([]);
    const blocked = await post(teamCode, message(`${PII_NAME}さんの体温`), gateway);
    expect(blocked.status).toBe(422);
    expect(httpErrorSchema.parse(await blocked.json()).code).toBe("pii_blocked");

    const scripted = "660003";
    await playTo(scripted, "s2");
    const refused = await post(scripted, message("質問"), gateway);
    expect(refused.status).toBe(409);
    expect(httpErrorSchema.parse(await refused.json()).code).toBe("no_ai_chat");
    expect(gateway.requests).toHaveLength(0);
  });

  it("429 は画面のエラーschemaを通り、Retry-After は秒の整数で返る", async () => {
    const teamCode = "660004";
    await playTo(teamCode, "s4");
    const saved = env.CHAT_RATE_LIMIT_PER_MINUTE;
    try {
      env.CHAT_RATE_LIMIT_PER_MINUTE = "1";
      const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
      expect((await post(teamCode, message("1通目"), gateway)).status).toBe(200);
      const limited = await post(teamCode, message("2通目"), gateway);
      expect(limited.status).toBe(429);
      httpErrorSchema.parse(await limited.json());
      // 画面（api/http.ts の parseRetryAfter）は秒だけを読む。日付の形で返すと秒数が消える。
      expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    } finally {
      env.CHAT_RATE_LIMIT_PER_MINUTE = saved;
    }
  });
});
