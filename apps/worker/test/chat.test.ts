import { env } from "cloudflare:workers";
import {
  chatMessageResultSchema,
  chatSnapshotSchema,
  createThreadResultSchema,
  httpErrorSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { AiGateway, ChatSnapshot, PromptProfile } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { handleChatMessage } from "../src/index.js";
import { OpenAiRefusalError } from "../src/openai-gateway.js";
import { collectMessages, postJson, session, upgrade } from "./support.js";

const createThread = (teamCode: string, commandId: string, title: string): Promise<Response> =>
  postJson(`/api/teams/${teamCode}/chat/threads`, { type: "create-thread", commandId, title });

const sendMessage = (
  teamCode: string,
  command: {
    commandId: string;
    threadId: string;
    text: string;
    promptProfile?: PromptProfile;
  },
  aiGateway: FakeAiGateway,
  nowMs = Date.now(),
): Promise<Response> =>
  handleChatMessage(
    new Request(`https://example.test/api/teams/${teamCode}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "send-message", ...command }),
    }),
    env,
    teamCode,
    { aiGateway, nowMs },
  );

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
      type: "send-message",
      commandId: "00000000-0000-4000-8000-000000000602",
      threadId,
      text: "本文",
    };
    const room = env.TEAM_ROOM.getByName("400006");
    const first = await room.beginChatMessage("400006", command);
    const second = await room.beginChatMessage("400006", command);
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
    await env.TEAM_ROOM.getByName("400007").beginChatMessage("400007", {
      type: "send-message",
      ...command,
    });

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
      env,
      "400008",
      { aiGateway: refusalGateway, nowMs: Date.now() },
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ message: expect.stringContaining("対応できません") });
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
    await env.TEAM_ROOM.getByName("400012").beginChatMessage("400012", {
      type: "send-message",
      commandId,
      threadId,
      text: "本文",
    });

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

  it("履歴に混入したPII（想定外経路のアシスタント応答）を検知し、追加のAI呼び出しをせず422を返す", async () => {
    await session("400014");
    const created = await createThread("400014", "00000000-0000-4000-8000-000000001401", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    // 送信前ゲートは今回の本文しか検査しない。ここではAI応答自体がPIIを含んで
    // 保存された状態を再現し、外部送信の直前で履歴側の防御が効くことを検証する。
    const gateway = new FakeAiGateway([
      { kind: "success", response: "渡辺 三郎さんの件、承知しました" },
    ]);
    const first = await sendMessage(
      "400014",
      { commandId: "00000000-0000-4000-8000-000000001402", threadId, text: "本文" },
      gateway,
    );
    expect(first.status).toBe(200);

    const response = await sendMessage(
      "400014",
      { commandId: "00000000-0000-4000-8000-000000001403", threadId, text: "別の本文" },
      gateway,
    );
    expect(response.status).toBe(422);
    const body = httpErrorSchema.parse(await response.json());
    expect(body.code).toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
  });

  it("履歴ブロック後、同じcommandIdで再送すると同じブロックが再現され、ユーザーメッセージは重複しない", async () => {
    await session("400015");
    const created = await createThread("400015", "00000000-0000-4000-8000-000000001501", "副");
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([
      { kind: "success", response: "渡辺 三郎さんの件、承知しました" },
    ]);
    await sendMessage(
      "400015",
      { commandId: "00000000-0000-4000-8000-000000001502", threadId, text: "本文" },
      gateway,
    );

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
      ["assistant", "渡辺 三郎さんの件、承知しました"],
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
});
