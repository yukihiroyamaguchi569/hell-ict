import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createThreadResultSchema } from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { PromptProfile } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { activitySchemaSql } from "../src/activity-log.js";
import { handleChatMessage, handleCreateThread } from "../src/index.js";
import { postJson, session } from "./support.js";

const rowSchema = z.object({
  eventId: z.string(),
  teamCode: z.string(),
  kind: z.string(),
  view: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  commandId: z.string(),
  role: z.string(),
  text: z.string(),
  meta: z.string(),
  clientAt: z.string(),
  createdAt: z.string(),
});

type Row = z.infer<typeof rowSchema>;

const ROWS_SQL = `SELECT
  event_id AS eventId,
  team_code AS teamCode,
  kind,
  view,
  thread_id AS threadId,
  message_id AS messageId,
  command_id AS commandId,
  role,
  text,
  meta,
  client_at AS clientAt,
  created_at AS createdAt
FROM activity_events
ORDER BY id`;

const rows = async (): Promise<Row[]> => {
  const result = await env.PROGRESS_DB.prepare(ROWS_SQL).all();
  return z.array(rowSchema).parse(result.results);
};

const metaOf = (row: Row | undefined): unknown => JSON.parse(row?.meta ?? "null");

const DROP_TABLE = "DROP TABLE IF EXISTS activity_events;";

/** ミリ秒まで刻んだISO 8601（前作で取れなかった発言単位の時刻）。 */
const MILLISECOND_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `waitUntil`へ逃がした活動ログの書き込み完了まで待ってから応答を返す。 */
const chat = async (
  teamCode: string,
  command: { commandId: string; threadId: string; text: string; promptProfile?: PromptProfile },
  aiGateway: FakeAiGateway,
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await handleChatMessage(
    new Request(`https://example.test/api/teams/${teamCode}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "send-message", ...command }),
    }),
    { env, ctx },
    teamCode,
    aiGateway,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const createThread = async (
  teamCode: string,
  commandId: string,
  title: string,
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await handleCreateThread(
    new Request(`https://example.test/api/teams/${teamCode}/chat/threads`, {
      method: "POST",
      body: JSON.stringify({ type: "create-thread", commandId, title }),
    }),
    { env, ctx },
    teamCode,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

/** メインスレッドのthreadIdを取り出す。各テストの前置きを短くするための切り出し。 */
const mainThreadId = async (teamCode: string, commandId: string): Promise<string> => {
  await session(teamCode);
  const created = await createThread(teamCode, commandId, "副");
  const { snapshot } = createThreadResultSchema.parse(await created.json());
  const threadId = snapshot.threads[0]?.threadId;
  if (threadId === undefined) throw new Error("unexpected");
  return threadId;
};

const activity = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  commandId: "00000000-0000-4000-8000-0000000000a1",
  kind: "verdict.s1",
  view: "s1",
  text: "判定に出した本文",
  meta: { verdict: "pass", score: 82 },
  clientAt: "2026-09-03T02:00:00.000Z",
  ...overrides,
});

// progress.test.tsと同じく、このpoolではD1の中身がテスト間で巻き戻らないため、
// 各テストの冒頭でテーブルごと作り直して白紙から始める。
describe("活動ログ", () => {
  beforeEach(async () => {
    await env.PROGRESS_DB.exec(DROP_TABLE);
    await env.PROGRESS_DB.exec(activitySchemaSql);
  });

  describe("サーバ側の自動記録", () => {
    it("1往復でchat.userとchat.assistantを各1行、ミリ秒精度の時刻付きで残す", async () => {
      const threadId = await mainThreadId("500001", "00000000-0000-4000-8000-000000000101");
      const gateway = new FakeAiGateway([{ kind: "success", response: "応答本文" }]);
      const response = await chat(
        "500001",
        {
          commandId: "00000000-0000-4000-8000-000000000102",
          threadId,
          text: "質問本文",
          promptProfile: "s3",
        },
        gateway,
      );
      expect(response.status).toBe(200);

      const chatRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(chatRows.map((row) => [row.kind, row.role, row.text])).toEqual([
        ["chat.user", "user", "質問本文"],
        ["chat.assistant", "assistant", "応答本文"],
      ]);
      for (const row of chatRows) {
        expect(row.eventId).toBe("dev");
        expect(row.teamCode).toBe("500001");
        expect(row.threadId).toBe(threadId);
        expect(row.commandId).toBe("00000000-0000-4000-8000-000000000102");
        expect(row.createdAt).toMatch(MILLISECOND_ISO);
      }
      expect(metaOf(chatRows[0])).toEqual({ promptProfile: "s3" });
      // messageIdはDOが採番したassistantメッセージのものが入る。
      expect(chatRows[1]?.messageId).not.toBe("");
    });

    it("同一commandIdの再送では行が増えない", async () => {
      const threadId = await mainThreadId("500002", "00000000-0000-4000-8000-000000000201");
      const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
      const command = {
        commandId: "00000000-0000-4000-8000-000000000202",
        threadId,
        text: "本文",
      };
      await chat("500002", command, gateway);
      await chat("500002", command, gateway);

      const chatRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(chatRows.map((row) => row.kind)).toEqual(["chat.user", "chat.assistant"]);
    });

    it("AI失敗後に同じcommandIdで再送しても、chat.userは1行のままでchat.failureが残る", async () => {
      const threadId = await mainThreadId("500003", "00000000-0000-4000-8000-000000000301");
      const gateway = new FakeAiGateway([
        { kind: "failure", error: new Error("rate limited") },
        { kind: "success", response: "応答" },
      ]);
      const command = {
        commandId: "00000000-0000-4000-8000-000000000302",
        threadId,
        text: "本文",
      };
      expect((await chat("500003", command, gateway)).status).toBe(503);
      const failureRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(failureRows.map((row) => row.kind)).toEqual(["chat.user", "chat.failure"]);

      expect((await chat("500003", command, gateway)).status).toBe(200);
      const retriedRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(retriedRows.map((row) => row.kind)).toEqual([
        "chat.user",
        "chat.failure",
        "chat.assistant",
      ]);
    });

    it("PIIブロックはchat.pii_blockedを1行だけ残し、本文を保存せずAIも呼ばない", async () => {
      const threadId = await mainThreadId("500004", "00000000-0000-4000-8000-000000000401");
      const gateway = new FakeAiGateway([]);
      const response = await chat(
        "500004",
        {
          commandId: "00000000-0000-4000-8000-000000000402",
          threadId,
          text: "渡辺 三郎さんの件で返信文を書いてください",
        },
        gateway,
      );
      expect(response.status).toBe(422);
      expect(gateway.requests).toHaveLength(0);

      const chatRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(chatRows.map((row) => row.kind)).toEqual(["chat.pii_blocked"]);
      expect(chatRows[0]?.text).toBe("");
      expect(metaOf(chatRows[0])).toEqual({ promptProfile: "default", length: 21 });
    });

    // 送信前ゲートはユーザー本文しか見ない。AI応答にPIIが混ざる経路は現に想定して
    // おり（blockHistoryPii）、その本文をD1へ残さないことをここで固定する。
    it("PIIを含むAI応答は、chat.assistantのtextを捨ててpiiRedactedを立てる", async () => {
      const threadId = await mainThreadId("500008", "00000000-0000-4000-8000-000000000801");
      const gateway = new FakeAiGateway([
        { kind: "success", response: "渡辺 三郎さんの件、承知しました" },
      ]);
      const response = await chat(
        "500008",
        { commandId: "00000000-0000-4000-8000-000000000802", threadId, text: "本文" },
        gateway,
      );
      expect(response.status).toBe(200);

      const chatRows = (await rows()).filter((row) => row.kind.startsWith("chat."));
      expect(chatRows.map((row) => row.kind)).toEqual(["chat.user", "chat.assistant"]);
      // ユーザー本文はPIIを含まないのでそのまま残る。
      expect(chatRows[0]?.text).toBe("本文");
      expect(metaOf(chatRows[0])).toEqual({ promptProfile: "default" });
      expect(chatRows[1]?.text).toBe("");
      expect(metaOf(chatRows[1])).toEqual({ promptProfile: "default", piiRedacted: true });
      // 本文を捨てても、どのメッセージだったかは追えるようにする。
      expect(chatRows[1]?.messageId).not.toBe("");
    });

    it("履歴に混入したPIIのブロックはchat.history_piiとして残る", async () => {
      const threadId = await mainThreadId("500005", "00000000-0000-4000-8000-000000000501");
      const gateway = new FakeAiGateway([
        { kind: "success", response: "渡辺 三郎さんの件、承知しました" },
      ]);
      await chat(
        "500005",
        { commandId: "00000000-0000-4000-8000-000000000502", threadId, text: "本文" },
        gateway,
      );
      const blocked = await chat(
        "500005",
        { commandId: "00000000-0000-4000-8000-000000000503", threadId, text: "別の本文" },
        gateway,
      );
      expect(blocked.status).toBe(422);

      const historyRows = (await rows()).filter((row) => row.kind === "chat.history_pii");
      expect(historyRows).toHaveLength(1);
      expect(historyRows[0]?.text).toBe("");
      expect(historyRows[0]?.commandId).toBe("00000000-0000-4000-8000-000000000503");
    });

    it("スレッド作成はthread.createとしてtitleごと残る", async () => {
      const teamCode = "500006";
      await session(teamCode);
      const created = await createThread(
        teamCode,
        "00000000-0000-4000-8000-000000000601",
        "Stage 3",
      );
      const { snapshot } = createThreadResultSchema.parse(await created.json());

      const threadRows = (await rows()).filter((row) => row.kind === "thread.create");
      expect(threadRows).toHaveLength(1);
      expect(threadRows[0]?.threadId).toBe(snapshot.threads.at(-1)?.threadId);
      expect(metaOf(threadRows[0])).toEqual({ title: "Stage 3" });
    });

    // metaにはサーバ生成のものでも利用者入力が混ざる（スレッドのtitleがそれ）。
    // textだけ見ていては塞げない口なので、meta側でも落ちることを固定する。
    it("PIIを含むスレッドtitleは、thread.createのmetaごと捨てられる", async () => {
      const teamCode = "500009";
      await session(teamCode);
      await createThread(teamCode, "00000000-0000-4000-8000-000000000901", "渡辺 三郎さんの件");

      const threadRows = (await rows()).filter((row) => row.kind === "thread.create");
      expect(threadRows).toHaveLength(1);
      expect(metaOf(threadRows[0])).toEqual({ piiRedacted: true });
      // titleを捨てても、いつスレッドが増えたかは追える。
      expect(threadRows[0]?.threadId).not.toBe("");
      expect(threadRows[0]?.text).toBe("");
    });

    // 記録はゲーム進行より優先度が低い。テーブルが消えていても応答は成功のままであること
    // （ログのためにチャットを落とさない）を、実際にDROPして確かめる。
    it("D1への書き込みが失敗しても、チャットの応答は成功のまま", async () => {
      const threadId = await mainThreadId("500007", "00000000-0000-4000-8000-000000000701");
      await env.PROGRESS_DB.exec(DROP_TABLE);

      const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
      const response = await chat(
        "500007",
        { commandId: "00000000-0000-4000-8000-000000000702", threadId, text: "本文" },
        gateway,
      );

      expect(response.status).toBe(200);
      expect(gateway.requests).toHaveLength(1);
      await env.PROGRESS_DB.exec(activitySchemaSql);
      expect(await rows()).toEqual([]);
    });
  });

  describe("クライアントからの記録（POST /api/teams/:code/activity）", () => {
    it("提出と判定を1行として受け取る", async () => {
      const response = await postJson("/api/teams/500101/activity", activity());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });

      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        eventId: "dev",
        teamCode: "500101",
        kind: "verdict.s1",
        view: "s1",
        text: "判定に出した本文",
        clientAt: "2026-09-03T02:00:00.000Z",
        role: "",
        threadId: "",
      });
      expect(metaOf(stored[0])).toEqual({ verdict: "pass", score: 82 });
      expect(stored[0]?.createdAt).toMatch(MILLISECOND_ISO);
    });

    it("同一commandIdの再送でも1行のまま", async () => {
      await postJson("/api/teams/500102/activity", activity());
      const repeated = await postJson("/api/teams/500102/activity", activity({ text: "書き直し" }));
      expect(repeated.status).toBe(200);

      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.text).toBe("判定に出した本文");
    });

    it("同じcommandIdでもkindが違えば別の行として残る", async () => {
      await postJson("/api/teams/500103/activity", activity({ kind: "submit.s1-reply" }));
      await postJson("/api/teams/500103/activity", activity({ kind: "verdict.s1" }));
      expect((await rows()).map((row) => row.kind)).toEqual(["submit.s1-reply", "verdict.s1"]);
    });

    it("PIIを含む本文はtextを捨て、piiRedactedを立てて記録だけ残す", async () => {
      const response = await postJson(
        "/api/teams/500104/activity",
        activity({ kind: "submit.s4", view: "s4", text: "渡辺 三郎さんの一覧を提出します" }),
      );
      expect(response.status).toBe(200);

      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.text).toBe("");
      expect(metaOf(stored[0])).toEqual({ verdict: "pass", score: 82, piiRedacted: true });
    });

    // クライアントは任意のmetaを送れる。textが綺麗でもmetaへPIIを詰められるので、
    // metaだけが反応したケースを独立に固定する。
    it("metaにPIIが混ざると、metaは丸ごと捨てられるがtextは残る", async () => {
      const response = await postJson(
        "/api/teams/500108/activity",
        activity({
          kind: "submit.s4",
          view: "s4",
          text: "匿名化した一覧を提出します",
          meta: { verdict: "fail", contact: "090-1234-5678" },
        }),
      );
      expect(response.status).toBe(200);

      const stored = await rows();
      expect(stored).toHaveLength(1);
      // 一致したキーだけでなくmeta全体を置き換える（どのキーに入るか決められないため）。
      expect(metaOf(stored[0])).toEqual({ piiRedacted: true });
      // metaが理由でtextまで捨てない。
      expect(stored[0]?.text).toBe("匿名化した一覧を提出します");
    });

    it.each([
      ["kindが列挙外", activity({ kind: "submit.unknown" })],
      ["commandIdがUUIDでない", activity({ commandId: "not-a-uuid" })],
      ["viewが空", activity({ view: "" })],
      ["viewに大文字", activity({ view: "S1" })],
      ["viewが33文字", activity({ view: "a".repeat(33) })],
      ["textが上限超過", activity({ text: "あ".repeat(20001) })],
      ["metaが4KB超", activity({ meta: { blob: "x".repeat(4100) } })],
      ["metaが配列", activity({ meta: [1, 2, 3] })],
      ["clientAtが欠落", { commandId: activity().commandId, kind: "resume", view: "s1" }],
      // 任意文字列のままだとPIIゲートを通らない列が残る。書式で塞いだことを固定する。
      ["clientAtが電話番号", activity({ clientAt: "090-1234-5678" })],
      ["clientAtがISO 8601でない", activity({ clientAt: "2026年9月3日 11時" })],
      ["bodyが配列", []],
      ["bodyがnull", null],
    ])("不正な入力(%s)は400で拒否し、行を増やさない", async (_label, body) => {
      const response = await postJson("/api/teams/500105/activity", body);
      expect(response.status).toBe(400);
      await expect(rows()).resolves.toEqual([]);
    });

    it("metaが4KBちょうどまでは受け付ける", async () => {
      // {"blob":"x…"} の固定部分11文字を差し引いて、ちょうど4096バイトへ揃える。
      const response = await postJson(
        "/api/teams/500106/activity",
        activity({ meta: { blob: "x".repeat(4096 - 11) } }),
      );
      expect(response.status).toBe(200);
      await expect(rows()).resolves.toHaveLength(1);
    });

    it("D1が失敗したら503を返す", async () => {
      await env.PROGRESS_DB.exec(DROP_TABLE);
      const response = await postJson("/api/teams/500107/activity", activity());
      expect(response.status).toBe(503);
      await env.PROGRESS_DB.exec(activitySchemaSql);
    });
  });
});
