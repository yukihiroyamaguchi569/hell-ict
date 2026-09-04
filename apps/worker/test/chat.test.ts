import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_MESSAGE_MAX_CHARS,
  PII_REDACTION,
  chatCommandFingerprint,
  chatMessageResultSchema,
  chatSnapshotSchema,
  createThreadResultSchema,
  httpErrorSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { AiGateway, ChatSnapshot, PromptProfile } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_RATE_LIMIT, RATE_LIMIT_WINDOW_MS } from "../src/guard.js";
import { handleChatMessage } from "../src/index.js";
import { OpenAiRefusalError } from "../src/openai-gateway.js";
import { collectMessages, get, postJson, session, upgrade } from "./support.js";

const createThread = (teamCode: string, commandId: string, title: string): Promise<Response> =>
  postJson(`/api/teams/${teamCode}/chat/threads`, { type: "create-thread", commandId, title });

const sendMessage = async (
  teamCode: string,
  command: {
    commandId: string;
    threadId: string;
    text: string;
    promptProfile?: PromptProfile;
  },
  aiGateway: FakeAiGateway,
  nowMs = Date.now(),
): Promise<Response> => {
  // 活動ログは`waitUntil`へ逃がすため、自前のExecutionContextを渡して
  // 書き込みの完了まで待てるようにする。
  const ctx = createExecutionContext();
  const response = await handleChatMessage(
    new Request(`https://example.test/api/teams/${teamCode}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "send-message", ...command }),
    }),
    { env, ctx },
    teamCode,
    { aiGateway, nowMs },
  );
  await waitOnExecutionContext(ctx);
  return response;
};

/**
 * DOのbeginChatMessageを直接呼ぶ。レート制限の固定窓を握るnowMs/limitと送信内容の
 * 指紋も渡す（省略すると実行時にNaN・undefinedが渡り、制限や取り違え検出が効かない
 * 状態でテストが通ってしまう）。
 */
const beginDirect = async (
  teamCode: string,
  command: { commandId: string; threadId: string; text: string; promptProfile?: PromptProfile },
  nowMs = Date.now(),
): Promise<unknown> =>
  env.TEAM_ROOM.getByName(teamCode).beginChatMessage(
    teamCode,
    { type: "send-message", ...command },
    {
      nowMs,
      limit: DEFAULT_CHAT_RATE_LIMIT,
      fingerprint: await chatCommandFingerprint(command),
    },
  );

/**
 * 保存経路の伏せ字化を迂回して、履歴へ平文のPIIを差し込む。伏せ字化を入れる前に
 * 保存された行など、想定外の経路で平文が残った状態を作り、外部送信の直前に効く
 * 履歴側の防御が残っていることを確かめるために使う。
 */
const injectAssistantPii = (teamCode: string, messageId: string): Promise<void> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
    const row = state.storage.sql.exec("SELECT snapshot FROM chat_state WHERE id = 1").toArray()[0];
    const parsed = JSON.parse(String(row?.snapshot)) as { threads: { messages: unknown[] }[] };
    parsed.threads[0]?.messages.push({
      messageId,
      role: "assistant",
      text: "渡辺 三郎さんの件、承知しました",
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    state.storage.sql.exec(
      "UPDATE chat_state SET snapshot = ? WHERE id = 1",
      JSON.stringify(parsed),
    );
  });

type PromptProfileCase = {
  readonly label: string;
  // 未指定（undefined）が"default"のケースを兼ねるので、明示できるのは残りのprofileだけ。
  // 共有の`PromptProfile`から引くことで、profileが増えたらここも自動で追従する。
  readonly promptProfile?: Exclude<PromptProfile, "default">;
  readonly teamCode: string;
  readonly threadCommandId: string;
  readonly messageCommandId: string;
};

/**
 * `testCase`のprofileで1件送信し、AIへ渡ったmessagesの先頭がsystemちょうど1件で
 * あることを検証したうえで、そのsystemメッセージ本文を返す。
 * 「3つのpromptProfileそれぞれで…」テストの複雑度を下げるための切り出し。
 */
const expectSingleLeadingSystemPrompt = async (testCase: PromptProfileCase): Promise<string> => {
  await session(testCase.teamCode);
  const created = await createThread(testCase.teamCode, testCase.threadCommandId, "副");
  const { snapshot } = createThreadResultSchema.parse(await created.json());
  const threadId = snapshot.threads[0]?.threadId;
  if (threadId === undefined) throw new Error("unexpected");

  const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
  await sendMessage(
    testCase.teamCode,
    {
      commandId: testCase.messageCommandId,
      threadId,
      text: "本文",
      promptProfile: testCase.promptProfile,
    },
    gateway,
  );

  const messages = gateway.requests[0]?.messages ?? [];
  const systemMessages = messages.filter((message) => message.role === "system");
  expect(messages[0]?.role, testCase.label).toBe("system");
  expect(systemMessages, testCase.label).toHaveLength(1);
  const text = systemMessages[0]?.text ?? "";
  expect(text.length, testCase.label).toBeGreaterThan(0);
  return text;
};

const chatSnapshotOf = async (teamCode: string): Promise<ChatSnapshot> => {
  const response = await upgrade(`/api/teams/${teamCode}/sync`);
  const [, chatEnvelope] = await collectMessages(response, 2);
  const envelope = teamSyncMessageSchema.parse(chatEnvelope);
  if (envelope.kind !== "chat") throw new Error("unexpected");
  return chatSnapshotSchema.parse(envelope.snapshot);
};

describe("P1C チャット骨格", () => {
  it("接続直後にteamとchatの両envelopeを配信する", async () => {
    await session("400000");
    const response = await upgrade("/api/teams/400000/sync");
    const [team, chat] = await collectMessages(response, 2);
    expect(teamSyncMessageSchema.parse(team).kind).toBe("team");
    const chatEnvelope = teamSyncMessageSchema.parse(chat);
    expect(chatEnvelope.kind).toBe("chat");
    if (chatEnvelope.kind !== "chat") throw new Error("unexpected");
    expect(chatEnvelope.snapshot.threads).toMatchObject([{ title: "メイン" }]);
  });

  it("複数スレッドが独立した文脈を持つ", async () => {
    await session("400001");
    const created = await createThread("400001", "00000000-0000-4000-8000-000000000101", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const mainThreadId = snapshot.threads[0]?.threadId;
    const subThreadId = snapshot.threads[1]?.threadId;
    if (mainThreadId === undefined || subThreadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([
      { kind: "success", response: "メイン応答" },
      { kind: "success", response: "副応答" },
    ]);
    await sendMessage(
      "400001",
      {
        commandId: "00000000-0000-4000-8000-000000000102",
        threadId: mainThreadId,
        text: "メインへ",
      },
      gateway,
    );
    await sendMessage(
      "400001",
      { commandId: "00000000-0000-4000-8000-000000000103", threadId: subThreadId, text: "副へ" },
      gateway,
    );

    const final = await chatSnapshotOf("400001");
    const main = final.threads.find((thread) => thread.threadId === mainThreadId);
    const sub = final.threads.find((thread) => thread.threadId === subThreadId);
    expect(main?.messages.map((m) => m.text)).toEqual(["メインへ", "メイン応答"]);
    expect(sub?.messages.map((m) => m.text)).toEqual(["副へ", "副応答"]);
  });

  it("同一commandIdの再送でメッセージが二重に増えない", async () => {
    await session("400002");
    const created = await createThread("400002", "00000000-0000-4000-8000-000000000201", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const command = {
      commandId: "00000000-0000-4000-8000-000000000202",
      threadId,
      text: "本文",
    };
    const first = await sendMessage("400002", command, gateway);
    const repeated = await sendMessage("400002", command, gateway);
    const firstResult = chatMessageResultSchema.parse(await first.json());
    const repeatedResult = chatMessageResultSchema.parse(await repeated.json());
    expect(firstResult).toEqual(repeatedResult);
    expect(gateway.requests).toHaveLength(1);

    const final = await chatSnapshotOf("400002");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => m.text)).toEqual(["本文", "応答"]);
  });

  it("AI失敗時はuserメッセージだけが残り、assistantは増えない", async () => {
    await session("400003");
    const created = await createThread("400003", "00000000-0000-4000-8000-000000000301", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "failure", error: new Error("rate limited") }]);
    const response = await sendMessage(
      "400003",
      { commandId: "00000000-0000-4000-8000-000000000302", threadId, text: "本文" },
      gateway,
    );
    expect(response.status).toBe(503);

    const final = await chatSnapshotOf("400003");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("AI失敗後、同じcommandIdで再送すると成功し、userメッセージは重複しない", async () => {
    await session("400005");
    const created = await createThread("400005", "00000000-0000-4000-8000-000000000501", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([
      { kind: "failure", error: new Error("rate limited") },
      { kind: "success", response: "応答" },
    ]);
    const command = {
      commandId: "00000000-0000-4000-8000-000000000502",
      threadId,
      text: "本文",
    };
    const failed = await sendMessage("400005", command, gateway);
    expect(failed.status).toBe(503);
    const retried = await sendMessage("400005", command, gateway);
    expect(retried.status).toBe(200);
    expect(gateway.requests).toHaveLength(2);

    const final = await chatSnapshotOf("400005");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "本文"],
      ["assistant", "応答"],
    ]);
  });

  it("同一commandIdの並行送信は2回目をin-progressとして拒否する", async () => {
    await session("400006");
    const created = await createThread("400006", "00000000-0000-4000-8000-000000000601", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const command = {
      commandId: "00000000-0000-4000-8000-000000000602",
      threadId,
      text: "本文",
    };
    const first = await beginDirect("400006", command);
    const second = await beginDirect("400006", command);
    expect(first).toMatchObject({ kind: "pending" });
    expect(second).toEqual({ kind: "in-progress" });
  });

  it("進行中のcommandIdへの送信はAIを呼ばず409を返す", async () => {
    await session("400007");
    const created = await createThread("400007", "00000000-0000-4000-8000-000000000701", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const command = {
      commandId: "00000000-0000-4000-8000-000000000702",
      threadId,
      text: "本文",
    };
    // 先にDOを直接呼び、pending行をクレームさせておく
    // （別リクエストが処理中の状態を再現する）。
    await beginDirect("400007", command);

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage("400007", command, gateway);
    expect(response.status).toBe(409);
    expect(gateway.requests).toHaveLength(0);
  });

  it("OpenAIのポリシー拒否は422を返し、汎用の再試行案内とは区別する", async () => {
    await session("400008");
    const created = await createThread("400008", "00000000-0000-4000-8000-000000000801", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const refusalGateway: AiGateway = {
      complete: () => Promise.reject(new OpenAiRefusalError("対応できません")),
    };
    const ctx = createExecutionContext();
    const response = await handleChatMessage(
      new Request("https://example.test/api/teams/400008/chat/messages", {
        method: "POST",
        body: JSON.stringify({
          type: "send-message",
          commandId: "00000000-0000-4000-8000-000000000802",
          threadId,
          text: "本文",
        }),
      }),
      { env, ctx },
      "400008",
      { aiGateway: refusalGateway, nowMs: Date.now() },
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(422);
    const body = httpErrorSchema.parse(await response.json());
    expect(body.message).toContain("対応できません");
    // 422は3種あり、保存済みか否かで再送方針が違う。ユーザー発言は保存済みなのでai_refusal。
    expect(body.code).toBe("ai_refusal");
  });

  it("PIIを含む送信は422でブロックし、AIを呼ばずチャットにも残さない", async () => {
    await session("400009");
    const created = await createThread("400009", "00000000-0000-4000-8000-000000000901", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([]);
    const response = await sendMessage(
      "400009",
      {
        commandId: "00000000-0000-4000-8000-000000000902",
        threadId,
        text: "渡辺 三郎さんの件で返信文を書いてください",
      },
      gateway,
    );
    expect(response.status).toBe(422);
    expect(gateway.requests).toHaveLength(0);
    const body = httpErrorSchema.parse(await response.json());
    expect(body.code).toBe("pii_blocked");

    const final = await chatSnapshotOf("400009");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages).toEqual([]);
  });

  // 送信前ゲートはpromptProfileより前に効く——ステージ別の振る舞いを足しても、
  // 「PIIをOpenAIへ送らない」（企画書§7）だけは全profileで降ろさない。判定を持たない
  // Final（promptProfile未指定＝default）や、参加者がコンテキスト欄へ名簿を貼りうる
  // Stage 1の下書き（`s1`）でも同じく止まることを、profileごとに固定する。
  it.each([
    { label: "未指定（Final）", teamCode: "400110", promptProfile: undefined },
    { label: "default", teamCode: "400111", promptProfile: "default" },
    { label: "s1", teamCode: "400112", promptProfile: "s1" },
    { label: "s3", teamCode: "400113", promptProfile: "s3" },
  ] as const)(
    "promptProfile=$labelでもPIIは送信前に止まり、AI呼び出しは0回",
    async ({ teamCode, promptProfile }) => {
      await session(teamCode);
      const created = await createThread(
        teamCode,
        `00000000-0000-4000-8000-0000000009${teamCode.slice(-2)}`,
        "副",
      );
      const { snapshot } = createThreadResultSchema.parse(await created.json());
      const threadId = snapshot.threads[0]?.threadId;
      if (threadId === undefined) throw new Error("unexpected");

      const gateway = new FakeAiGateway([]);
      const response = await sendMessage(
        teamCode,
        {
          commandId: `00000000-0000-4000-8000-0000000008${teamCode.slice(-2)}`,
          threadId,
          text: "長峰 静香さんの件をまとめてください",
          promptProfile,
        },
        gateway,
      );

      expect(response.status).toBe(422);
      expect(gateway.requests).toHaveLength(0);
      expect(httpErrorSchema.parse(await response.json()).code).toBe("pii_blocked");
      const stored = await chatSnapshotOf(teamCode);
      expect(stored.threads.find((t) => t.threadId === threadId)?.messages).toEqual([]);
    },
  );

  it("匿名化した依頼はゲートを素通りしてAIへ届く", async () => {
    await session("400010");
    const created = await createThread("400010", "00000000-0000-4000-8000-000000001001", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "承知しました" }]);
    const response = await sendMessage(
      "400010",
      {
        commandId: "00000000-0000-4000-8000-000000001002",
        threadId,
        text: "5A病棟の70代男性のご家族へ、面会制限の説明文を作成してください",
      },
      gateway,
    );
    expect(response.status).toBe(200);
    expect(gateway.requests).toHaveLength(1);
  });

  it("処理済みcommandIdへPIIを含む本文で再送してもAIを呼ばず422を返す", async () => {
    await session("400011");
    const created = await createThread("400011", "00000000-0000-4000-8000-000000001101", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const commandId = "00000000-0000-4000-8000-000000001102";
    const first = await sendMessage("400011", { commandId, threadId, text: "本文" }, gateway);
    expect(first.status).toBe(200);

    const retried = await sendMessage(
      "400011",
      { commandId, threadId, text: "渡辺 三郎さんの件です" },
      gateway,
    );
    expect(retried.status).toBe(422);
    expect(gateway.requests).toHaveLength(1);
  });

  it("進行中commandIdへPIIを含む本文を送ってもAIを呼ばず422を返す", async () => {
    await session("400012");
    const created = await createThread("400012", "00000000-0000-4000-8000-000000001201", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000001202";
    await beginDirect("400012", { commandId, threadId, text: "本文" });

    const gateway = new FakeAiGateway([]);
    const response = await sendMessage(
      "400012",
      { commandId, threadId, text: "渡辺 三郎さんの件です" },
      gateway,
    );
    expect(response.status).toBe(422);
    expect(gateway.requests).toHaveLength(0);
  });

  it("ブロックされた送信はpending/processedを残さず、同じcommandIdでの再送を妨げない", async () => {
    await session("400013");
    const created = await createThread("400013", "00000000-0000-4000-8000-000000001301", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const commandId = "00000000-0000-4000-8000-000000001302";
    const blocked = await sendMessage(
      "400013",
      { commandId, threadId, text: "渡辺 三郎さんの件です" },
      gateway,
    );
    expect(blocked.status).toBe(422);

    const retried = await sendMessage("400013", { commandId, threadId, text: "本文" }, gateway);
    expect(retried.status).toBe(200);
    expect(gateway.requests).toHaveLength(1);

    const final = await chatSnapshotOf("400013");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "本文"],
      ["assistant", "応答"],
    ]);
  });

  it("PIIを含むAI応答は伏せ字で保存され、次の送信も履歴ゲートに掛からない", async () => {
    await session("400014");
    const created = await createThread("400014", "00000000-0000-4000-8000-000000001401", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    // 送信前ゲートは今回の本文しか検査しない。AI応答自体がPIIを含んで返ってきた場合は、
    // 保存前に伏せ字へ置き換える（拒否にすると再送で同じ応答が返り課金だけ増える）。
    const gateway = new FakeAiGateway([
      { kind: "success", response: "渡辺 三郎さんの件、承知しました" },
      { kind: "success", response: "了解しました" },
    ]);
    const first = await sendMessage(
      "400014",
      { commandId: "00000000-0000-4000-8000-000000001402", threadId, text: "本文" },
      gateway,
    );
    expect(first.status).toBe(200);
    const firstBody = chatMessageResultSchema.parse(await first.json());
    expect(firstBody.assistant.text).not.toContain("渡辺 三郎");
    expect(firstBody.assistant.text).toContain(PII_REDACTION);

    // GETでも伏せ字（DOのchat_stateに平文が残っていない）。
    const stored = chatSnapshotSchema.parse(await (await get("/api/teams/400014/chat")).json());
    const texts = stored.threads.flatMap((thread) => thread.messages).map((m) => m.text);
    expect(texts.some((text) => text.includes("渡辺 三郎"))).toBe(false);
    expect(texts.some((text) => text.includes(PII_REDACTION))).toBe(true);

    // 履歴に平文が残っていないので、次の送信は履歴PIIゲートに掛からない。
    const next = await sendMessage(
      "400014",
      { commandId: "00000000-0000-4000-8000-000000001403", threadId, text: "別の本文" },
      gateway,
    );
    expect(next.status).toBe(200);
    expect(gateway.requests).toHaveLength(2);
  });

  it("履歴に平文のPIIが残っていた場合は、AIを呼ばず422 history_piiで止める", async () => {
    await session("400030");
    const created = await createThread("400030", "00000000-0000-4000-8000-000000003001", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    await injectAssistantPii("400030", "00000000-0000-4000-8000-000000003002");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage(
      "400030",
      { commandId: "00000000-0000-4000-8000-000000003003", threadId, text: "本文" },
      gateway,
    );

    expect(response.status).toBe(422);
    expect(httpErrorSchema.parse(await response.json()).code).toBe("history_pii");
    expect(gateway.requests).toHaveLength(0);
  });

  it("履歴ブロック後、同じcommandIdで再送すると同じブロックが再現され、ユーザーメッセージは重複しない", async () => {
    await session("400015");
    const created = await createThread("400015", "00000000-0000-4000-8000-000000001501", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    await sendMessage(
      "400015",
      { commandId: "00000000-0000-4000-8000-000000001502", threadId, text: "本文" },
      gateway,
    );
    // AI応答は保存時に伏せ字化されるので、履歴ゲートを踏ませるには平文を差し込む。
    await injectAssistantPii("400015", "00000000-0000-4000-8000-000000001504");

    const command = {
      commandId: "00000000-0000-4000-8000-000000001503",
      threadId,
      text: "別の本文",
    };
    const first = await sendMessage("400015", command, gateway);
    expect(first.status).toBe(422);
    const retried = await sendMessage("400015", command, gateway);
    expect(retried.status).toBe(422);
    expect(gateway.requests).toHaveLength(1);

    const final = await chatSnapshotOf("400015");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "本文"],
      ["assistant", "応答"],
      // 差し込んだ平文のPII。これが履歴ゲートを踏ませている。
      ["assistant", "渡辺 三郎さんの件、承知しました"],
      // ブロックされた送信のユーザー発言は1件だけ（再送で二重に積まれない）。
      ["user", "別の本文"],
    ]);
  });

  it("3つのpromptProfileそれぞれで、AIへ送るmessagesの先頭にsystemが1件だけ前置される", async () => {
    // 期待値をsystemPromptFor()自身にするとトートロジーになるため、ここでは
    // 「systemがindex 0にちょうど1件」「3種の本文が互いに異なる」
    // 「s3は接触予防策の方針を含み、角化型には触れない」という、実装本文に
    // 依存しない緩い性質だけを検証する。
    const cases: readonly PromptProfileCase[] = [
      {
        label: "省略（default扱い）",
        teamCode: "400016",
        threadCommandId: "00000000-0000-4000-8000-000000001601",
        messageCommandId: "00000000-0000-4000-8000-000000001602",
      },
      {
        label: "s1",
        promptProfile: "s1",
        teamCode: "400017",
        threadCommandId: "00000000-0000-4000-8000-000000001701",
        messageCommandId: "00000000-0000-4000-8000-000000001702",
      },
      {
        label: "s3",
        promptProfile: "s3",
        teamCode: "400018",
        threadCommandId: "00000000-0000-4000-8000-000000001801",
        messageCommandId: "00000000-0000-4000-8000-000000001802",
      },
    ];

    const systemPromptTexts: string[] = [];
    for (const testCase of cases) {
      systemPromptTexts.push(await expectSingleLeadingSystemPrompt(testCase));
    }

    expect(new Set(systemPromptTexts).size).toBe(3);
    const [, , s3PromptText] = systemPromptTexts;
    expect(s3PromptText).toContain("接触予防策");
    // "角化型"は「利用者には言及しない」という内部方針の説明に必要な語として
    // システムプロンプト自身には現れる（AIへの指示であり、AI出力ではない）。
    // そのため「含まない」ではなく、「疥癬に触れるのはs3のプロンプトだけ」という、
    // s1・defaultとの識別性を検証する。
    expect(systemPromptTexts.filter((text) => text.includes("疥癬"))).toEqual([s3PromptText]);
  });

  it("同一スレッドへの2ターン目でもsystemはindex 0に1件だけで、保存済み履歴はuser/assistantのみになる", async () => {
    await session("400019");
    const created = await createThread("400019", "00000000-0000-4000-8000-000000001901", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([
      { kind: "success", response: "1ターン目の応答" },
      { kind: "success", response: "2ターン目の応答" },
    ]);
    await sendMessage(
      "400019",
      {
        commandId: "00000000-0000-4000-8000-000000001902",
        threadId,
        text: "1ターン目",
        promptProfile: "s3",
      },
      gateway,
    );
    await sendMessage(
      "400019",
      {
        commandId: "00000000-0000-4000-8000-000000001903",
        threadId,
        text: "2ターン目",
        promptProfile: "s3",
      },
      gateway,
    );

    expect(gateway.requests).toHaveLength(2);
    for (const request of gateway.requests) {
      const systemMessages = request.messages.filter((message) => message.role === "system");
      expect(request.messages[0]?.role).toBe("system");
      expect(systemMessages).toHaveLength(1);
    }
    // 2ターン目のリクエストには1ターン目のuser/assistantが履歴として積まれているはず。
    expect(gateway.requests[1]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);

    const final = await chatSnapshotOf("400019");
    const thread = final.threads.find((t) => t.threadId === threadId);
    expect(thread?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(thread?.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("未知スレッドへの送信は404で拒否し、状態を変えない", async () => {
    await session("400004");
    const gateway = new FakeAiGateway([]);
    const response = await sendMessage(
      "400004",
      {
        commandId: "00000000-0000-4000-8000-000000000401",
        threadId: "00000000-0000-4000-8000-0000000000ff",
        text: "本文",
      },
      gateway,
    );
    expect(response.status).toBe(404);
    expect(gateway.requests).toHaveLength(0);
  });
  it("同じcommandIdを別スレッドへ使い回すと409 conflictで、別スレッドの文脈をAIへ渡さない", async () => {
    await session("400020");
    const first = await createThread("400020", "00000000-0000-4000-8000-000000002001", "副");
    const { snapshot } = createThreadResultSchema.parse(await first.json());
    const mainThreadId = snapshot.threads[0]?.threadId;
    const subThreadId = snapshot.threads[1]?.threadId;
    if (mainThreadId === undefined || subThreadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002002";
    // 先にDOを直接呼んでpending行を作る（AI応答待ちの状態を再現する）。
    await beginDirect("400020", { commandId, threadId: mainThreadId, text: "本文" });

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage(
      "400020",
      { commandId, threadId: subThreadId, text: "本文" },
      gateway,
    );

    expect(response.status).toBe(409);
    expect(httpErrorSchema.parse(await response.json()).code).toBe("conflict");
    expect(gateway.requests).toHaveLength(0);
  });

  it("同じcommandIdを別のpromptProfileで使い回すと409 conflict", async () => {
    await session("400021");
    const created = await createThread("400021", "00000000-0000-4000-8000-000000002101", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002102";
    // profile未指定は"default"として保存される。
    await beginDirect("400021", { commandId, threadId, text: "本文" });

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage(
      "400021",
      { commandId, threadId, text: "本文", promptProfile: "s1" },
      gateway,
    );

    expect(response.status).toBe(409);
    expect(httpErrorSchema.parse(await response.json()).code).toBe("conflict");
    expect(gateway.requests).toHaveLength(0);
  });

  it("同じスレッド・同じprofileの再送は従来どおり扱う", async () => {
    await session("400022");
    const created = await createThread("400022", "00000000-0000-4000-8000-000000002201", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002202";
    await beginDirect("400022", { commandId, threadId, text: "本文" });

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage("400022", { commandId, threadId, text: "本文" }, gateway);

    // クレームが生きている間は"in-progress"（409）。conflictとは別のcodeなしの409。
    expect(response.status).toBe(409);
    expect(httpErrorSchema.parse(await response.json()).code).toBeUndefined();
  });
  it("同じcommandIdで別の本文を送ると409 conflictで、AIも呼ばず保存もしない", async () => {
    await session("400023");
    const created = await createThread("400023", "00000000-0000-4000-8000-000000002301", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002302";
    await beginDirect("400023", { commandId, threadId, text: "最初の本文" });
    const before = await chatSnapshotOf("400023");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await sendMessage(
      "400023",
      { commandId, threadId, text: "すり替えた本文" },
      gateway,
    );

    expect(response.status).toBe(409);
    expect(httpErrorSchema.parse(await response.json()).code).toBe("conflict");
    expect(gateway.requests).toHaveLength(0);
    await expect(chatSnapshotOf("400023")).resolves.toEqual(before);
  });

  it("処理済みcommandIdへ別の本文を送っても409 conflict", async () => {
    await session("400024");
    const created = await createThread("400024", "00000000-0000-4000-8000-000000002401", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002402";
    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const first = await sendMessage("400024", { commandId, threadId, text: "最初の本文" }, gateway);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // 完了後（processed行）でも内容の取り違えは検出する。
    const swapped = await sendMessage(
      "400024",
      { commandId, threadId, text: "すり替えた本文" },
      gateway,
    );
    expect(swapped.status).toBe(409);
    expect(httpErrorSchema.parse(await swapped.json()).code).toBe("conflict");
    expect(gateway.requests).toHaveLength(1);

    // 同じ内容の再送は従来どおり、同じ結果をそのまま返す。
    const resent = await sendMessage(
      "400024",
      { commandId, threadId, text: "最初の本文" },
      gateway,
    );
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toEqual(firstBody);
    expect(gateway.requests).toHaveLength(1);
  });
  it("AI失敗後の再送も枠を消費し、同じcommandIdでOpenAIを呼び続けられない", async () => {
    await session("400025");
    const created = await createThread("400025", "00000000-0000-4000-8000-000000002501", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    // completeChatMessageはAI失敗でクレームを解放するので、同じcommandIdの再送は
    // 何度でもAIを呼べてしまっていた。再試行も枠を消費することを固定する。
    const windowStartMs = 1_756_200_000_000;
    const commandId = "00000000-0000-4000-8000-000000002502";
    const gateway = new FakeAiGateway(
      Array.from({ length: DEFAULT_CHAT_RATE_LIMIT + 1 }, () => ({
        kind: "failure" as const,
        error: new Error("一時障害"),
      })),
    );

    for (let attempt = 0; attempt < DEFAULT_CHAT_RATE_LIMIT; attempt += 1) {
      const response = await sendMessage(
        "400025",
        { commandId, threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
      expect(response.status, `#${String(attempt)}`).toBe(503);
    }
    expect(gateway.requests).toHaveLength(DEFAULT_CHAT_RATE_LIMIT);

    const blocked = await sendMessage(
      "400025",
      { commandId, threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    // 429の分はAIを呼んでいない。
    expect(gateway.requests).toHaveLength(DEFAULT_CHAT_RATE_LIMIT);

    // 窓が明ければ同じcommandIdで再開できる（pending行は消していない）。
    const revived = await sendMessage(
      "400025",
      { commandId, threadId, text: "本文" },
      gateway,
      windowStartMs + RATE_LIMIT_WINDOW_MS,
    );
    expect(revived.status).toBe(503);
    expect(gateway.requests).toHaveLength(DEFAULT_CHAT_RATE_LIMIT + 1);
  });
  it("空白だけのAI応答は保存せず、snapshotを汚さない", async () => {
    await session("400026");
    const created = await createThread("400026", "00000000-0000-4000-8000-000000002601", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const before = await chatSnapshotOf("400026");
    const gateway = new FakeAiGateway([{ kind: "success", response: "   " }]);
    const response = await sendMessage(
      "400026",
      { commandId: "00000000-0000-4000-8000-000000002602", threadId, text: "本文" },
      gateway,
    );

    // 空の本文をsnapshotへ積むと、以後の読み出しがparse失敗で丸ごと壊れる。
    expect(response.status).toBe(503);
    const after = await chatSnapshotOf("400026");
    const messages = after.threads.flatMap((thread) => thread.messages);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    // ユーザー発言までは保存済み（再送で二重に積まれない）。
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(before.threads).toHaveLength(after.threads.length);
  });

  it("上限を超えるAI応答は切り詰めて保存し、その後の読み出しも通る", async () => {
    await session("400027");
    const created = await createThread("400027", "00000000-0000-4000-8000-000000002701", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([
      { kind: "success", response: "あ".repeat(CHAT_MESSAGE_MAX_CHARS + 1) },
    ]);
    const response = await sendMessage(
      "400027",
      { commandId: "00000000-0000-4000-8000-000000002702", threadId, text: "本文" },
      gateway,
    );

    expect(response.status).toBe(200);
    const body = chatMessageResultSchema.parse(await response.json());
    expect(body.assistant.text).toHaveLength(CHAT_MESSAGE_MAX_CHARS);

    // 保存後のGETがschemaで落ちないこと（切り詰めずに積むとここで壊れる）。
    const snapshotResponse = await get("/api/teams/400027/chat");
    expect(snapshotResponse.status).toBe(200);
    const stored = chatSnapshotSchema.parse(await snapshotResponse.json());
    const assistant = stored.threads.flatMap((thread) => thread.messages).at(-1);
    expect(assistant?.text).toHaveLength(CHAT_MESSAGE_MAX_CHARS);
  });

  it("古いclaim generationのcompleteは無視され、新しいclaimの処理が確定する", async () => {
    await session("400028");
    const created = await createThread("400028", "00000000-0000-4000-8000-000000002801", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const commandId = "00000000-0000-4000-8000-000000002802";
    const room = env.TEAM_ROOM.getByName("400028");
    // generation 1 でクレームを取る。
    const first = await beginDirect("400028", { commandId, threadId, text: "本文" });
    expect(first).toMatchObject({ kind: "pending", claimGeneration: 1 });

    // AIが失敗してクレームが解放され、再送が generation 2 で取り直す。
    await room.completeChatMessage(commandId, { kind: "failure" }, 1);
    const second = await beginDirect("400028", { commandId, threadId, text: "本文" });
    expect(second).toMatchObject({ kind: "pending", claimGeneration: 2 });

    // 遅れて戻ってきた generation 1 の応答は捨てる。
    const stale = await room.completeChatMessage(
      commandId,
      { kind: "success", text: "古い応答" },
      1,
    );
    expect(stale).toEqual({ stale: true });
    const afterStale = await chatSnapshotOf("400028");
    expect(afterStale.threads.flatMap((t) => t.messages).map((m) => m.text)).not.toContain(
      "古い応答",
    );

    // generation 2 の応答は確定する。
    const applied = await room.completeChatMessage(
      commandId,
      { kind: "success", text: "新しい応答" },
      2,
    );
    expect(applied).toMatchObject({ assistant: { text: "新しい応答" } });
  });
});
