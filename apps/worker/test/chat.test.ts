import { env } from "cloudflare:workers";
import {
  chatMessageResultSchema,
  chatSnapshotSchema,
  createThreadResultSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { AiGateway, ChatSnapshot } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { handleChatMessage } from "../src/index.js";
import { OpenAiRefusalError } from "../src/openai-gateway.js";
import { collectMessages, postJson, session, upgrade } from "./support.js";

const createThread = (teamCode: string, commandId: string, title: string): Promise<Response> =>
  postJson(`/api/teams/${teamCode}/chat/threads`, { type: "create-thread", commandId, title });

const sendMessage = (
  teamCode: string,
  command: { commandId: string; threadId: string; text: string },
  aiGateway: FakeAiGateway,
): Promise<Response> =>
  handleChatMessage(
    new Request(`https://example.test/api/teams/${teamCode}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "send-message", ...command }),
    }),
    env,
    teamCode,
    aiGateway,
  );

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
      refusalGateway,
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ message: expect.stringContaining("対応できません") });
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
