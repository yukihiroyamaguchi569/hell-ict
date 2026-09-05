import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  chatMessageSchema,
  chatSnapshotSchema,
  createThreadResultSchema,
  PII_REDACTION,
} from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { PromptProfile } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ACTIVITY_RATE_LIMIT_PER_MINUTE,
  DEFAULT_CHAT_RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
} from "../src/guard.js";
import { activitySchemaSql, handleActivityPost } from "../src/activity-log.js";
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
  nowMs = Date.now(),
): Promise<Response> => {
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

const createThread = async (
  teamCode: string,
  commandId: string,
  title: string,
  kind?: "stage" | "manual",
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await handleCreateThread(
    new Request(`https://example.test/api/teams/${teamCode}/chat/threads`, {
      method: "POST",
      body: JSON.stringify({ type: "create-thread", commandId, title, kind }),
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

/** 連番からUUID形式のcommandIdを作る（活動ログのschemaはUUIDを要求する）。 */
const uniqueCommandId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * JSONが4096バイト（`tail`が"x"のとき）ちょうどになるmeta。値ごとの200文字上限を
 * 守るため、「あ」を複数キーへ分けて積む。末尾を1文字増やすと4097バイトになる。
 */
const sizedMeta = (tail: string): Record<string, string> => {
  const meta: Record<string, string> = {};
  for (let index = 0; index < 9; index += 1) meta[`k${String(index)}`] = "あ".repeat(136);
  meta.k9 = "あ".repeat(114) + tail;
  return meta;
};

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
    it("PIIを含むAI応答は伏せ字で保存され、活動ログにも平文が残らない", async () => {
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
      // AI応答はDOへ保存される時点で伏せ字化済み。活動ログにも平文は届かないので、
      // 活動ログ側のtext空化（piiRedacted）は発動しない。
      expect(chatRows[1]?.text).not.toContain("渡辺 三郎");
      expect(chatRows[1]?.text).toContain(PII_REDACTION);
      expect(metaOf(chatRows[1])).toEqual({ promptProfile: "default" });
      expect(chatRows[1]?.messageId).not.toBe("");
    });

    it("活動ログへ平文のPIIが渡った場合は、textを捨ててpiiRedactedを立てる", async () => {
      // AI応答は保存前に伏せ字化されるので通常はここへ来ないが、活動ログ側の防御は
      // 全ての書き込みに掛かる最後の砦として残す。ユーザー本文の経路で確かめる。
      const threadId = await mainThreadId("500019", "00000000-0000-4000-8000-000000001901");
      const gateway = new FakeAiGateway([]);
      const blocked = await chat(
        "500019",
        {
          commandId: "00000000-0000-4000-8000-000000001902",
          threadId,
          text: "渡辺 三郎さんの件で返信文を書いてください",
        },
        gateway,
      );
      expect(blocked.status).toBe(422);

      const piiRows = (await rows()).filter((row) => row.kind === "chat.pii_blocked");
      expect(piiRows).toHaveLength(1);
      expect(piiRows[0]?.text).toBe("");
    });

    it("伏せ字化より前に保存された平文があっても、送信は通り伏せ字で記録される", async () => {
      const threadId = await mainThreadId("500005", "00000000-0000-4000-8000-000000000501");
      const gateway = new FakeAiGateway([
        { kind: "success", response: "応答" },
        { kind: "success", response: "二度目の応答" },
      ]);
      await chat(
        "500005",
        { commandId: "00000000-0000-4000-8000-000000000502", threadId, text: "本文" },
        gateway,
      );
      // 伏せ字化を入れる前に保存された行を再現する。読み出し時に伏せ字化されるので、
      // 履歴ゲート（chat.history_pii）はもう踏まれない。
      await runInDurableObject(env.TEAM_ROOM.getByName("500005"), (_instance, state) => {
        const row = state.storage.sql
          .exec("SELECT snapshot FROM chat_state WHERE id = 1")
          .toArray()[0];
        const parsed = chatSnapshotSchema.parse(JSON.parse(String(row?.snapshot)) as unknown);
        parsed.threads[0]?.messages.push(
          chatMessageSchema.parse({
            messageId: "00000000-0000-4000-8000-000000000504",
            role: "assistant",
            text: "渡辺 三郎さんの件、承知しました",
            createdAt: "2026-09-04T00:00:00.000Z",
          }),
        );
        state.storage.sql.exec(
          "UPDATE chat_state SET snapshot = ? WHERE id = 1",
          JSON.stringify(parsed),
        );
      });

      const response = await chat(
        "500005",
        { commandId: "00000000-0000-4000-8000-000000000503", threadId, text: "別の本文" },
        gateway,
      );
      expect(response.status).toBe(200);

      const kinds = (await rows()).map((row) => row.kind);
      expect(kinds).not.toContain("chat.history_pii");
      // 活動ログへ渡る本文にも平文は残らない。
      const stored = JSON.stringify(await rows());
      expect(stored).not.toContain("渡辺 三郎");
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

    it("既存のステージスレッドを返しただけのときはthread.createを記録しない", async () => {
      // ステージスレッドはtitleで一意。リロードやタブの競合で作成要求が二重に来ても
      // スレッドは増えない。増えていないのに記録が積まれると、分析上は「文脈を
      // 分けた回数」が水増しされ、しかも末尾スレッドの無関係なIDが載る。
      const teamCode = "500011";
      await session(teamCode);
      const first = await createThread(
        teamCode,
        "00000000-0000-4000-8000-000000001101",
        "Stage 3",
        "stage",
      );
      const { snapshot } = createThreadResultSchema.parse(await first.json());
      const created = snapshot.threads.at(-1)?.threadId;

      // 参加者が手動スレッドを足し、末尾が別のスレッドになった状態を作る。
      await createThread(teamCode, "00000000-0000-4000-8000-000000001102", "メモ", "manual");

      // 別のcommandIdで同じステージスレッドをもう一度要求する（冪等台帳では止まらない）。
      const again = await createThread(
        teamCode,
        "00000000-0000-4000-8000-000000001103",
        "Stage 3",
        "stage",
      );
      expect(again.status).toBe(200);
      const replay = createThreadResultSchema.parse(await again.json());
      // 入室時からあるメインスレッドを含めて3本。Stage 3 は増えていない。
      expect(replay.snapshot.threads).toHaveLength(3);

      const threadRows = (await rows()).filter((row) => row.kind === "thread.create");
      // 記録は実際に増えた2本ぶんだけ。3本目（重複抑止）は積まれない。
      expect(threadRows).toHaveLength(2);
      expect(threadRows.map((row) => row.threadId)).toContain(created);
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

  describe("旧インデックスからの移行", () => {
    it("旧定義のUNIQUEが残ったD1でも、新しいインデックスへ置き換わる", async () => {
      // CREATE INDEX IF NOT EXISTS は「同じ名前が既にある」だけで何もしない。
      // 名前を変えずにキー構成だけ直しても既存のD1には反映されず、狭いキーで
      // 本物のイベントが捨てられ続ける。
      await env.PROGRESS_DB.exec(DROP_TABLE);
      await env.PROGRESS_DB.exec(
        "CREATE TABLE IF NOT EXISTS activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL DEFAULT '', team_code TEXT NOT NULL, kind TEXT NOT NULL, view TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', command_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', client_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));",
      );
      // 旧定義: command_idだけの狭いキー。別チームの同じcommandIdが衝突する。
      await env.PROGRESS_DB.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_command ON activity_events(command_id) WHERE command_id <> '';",
      );

      await env.PROGRESS_DB.exec(activitySchemaSql);

      const indexes = await env.PROGRESS_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity_events'",
      ).all();
      const names = z
        .array(z.object({ name: z.string() }))
        .parse(indexes.results)
        .map((row) => row.name);
      expect(names).toContain("idx_activity_idempotency_v2");
      expect(names).not.toContain("idx_activity_command");

      // 別チームの同じcommandIdが両方入る（旧定義なら片方が黙って捨てられていた）。
      const commandId = uniqueCommandId(700);
      const insert = env.PROGRESS_DB.prepare(
        "INSERT OR IGNORE INTO activity_events (team_code, kind, command_id) VALUES (?, 'verdict.s1', ?)",
      );
      await env.PROGRESS_DB.batch([
        insert.bind("500180", commandId),
        insert.bind("500181", commandId),
      ]);
      const stored = await rows();
      expect(stored.filter((row) => row.commandId === commandId)).toHaveLength(2);
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

    // commandIdはクライアント採番なので、別チームで衝突しうる。冪等性のキーが
    // 狭いと、後から来た本物のイベントがINSERT OR IGNOREで黙って消える。
    it("別チームが同じcommandId・kindを送っても、両方が保存される", async () => {
      const first = await postJson("/api/teams/500110/activity", activity());
      const second = await postJson("/api/teams/500111/activity", activity());
      expect([first.status, second.status]).toEqual([200, 200]);

      const stored = await rows();
      expect(stored.map((row) => row.teamCode)).toEqual(["500110", "500111"]);
      expect(new Set(stored.map((row) => row.commandId)).size).toBe(1);
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

    // 値が複数フィールドへ分かれるとJSON全体の検査では拾えないため、各string値も
    // 個別に通している。片方だけでは電話番号として成立しない分割は検知されない——
    // 検出器の語彙を跨ぐ分割（姓と名を別フィールドへ置くなど）は原理的に拾えず、
    // これはdetectPiiの限界であることを、期待値として明示しておく。
    it("値が分断されたPIIは検知されず、そのまま保存される（検出器の限界）", async () => {
      const response = await postJson(
        "/api/teams/500112/activity",
        activity({ meta: { a: "090-1234", b: "-5678" } }),
      );
      expect(response.status).toBe(200);
      expect(metaOf((await rows())[0])).toEqual({ a: "090-1234", b: "-5678" });
    });

    // JSON全体の検査だけでは足りない実例。改行を含む値はJSON化で `\n` の2文字へ
    // 変換されるため、氏名パターンの `\s*` が一致しなくなる。各string値を素のまま
    // 個別に通しているので落とせる。
    it("JSON化で崩れる値のPIIも、string値の個別検査で落とす", async () => {
      const response = await postJson(
        "/api/teams/500114/activity",
        activity({ meta: { note: "渡辺\n三郎さんの件" } }),
      );
      expect(response.status).toBe(200);
      expect(metaOf((await rows())[0])).toEqual({ piiRedacted: true });
    });

    it("識別子として妥当なキー（英数字と_.-）は受け付ける", async () => {
      const response = await postJson(
        "/api/teams/500115/activity",
        activity({ meta: { "stage_2.ok": true, "k-1": 1, [`${"k".repeat(64)}`]: null } }),
      );
      expect(response.status).toBe(200);
      expect(metaOf((await rows())[0])).toEqual({
        "stage_2.ok": true,
        "k-1": 1,
        [`${"k".repeat(64)}`]: null,
      });
    });

    it("1つのフィールドに収まった電話番号は、meta全体の置換で落とす", async () => {
      const response = await postJson(
        "/api/teams/500113/activity",
        activity({ meta: { phone: "090-1234-5678" } }),
      );
      expect(response.status).toBe(200);
      expect(metaOf((await rows())[0])).toEqual({ piiRedacted: true });
    });

    it.each([
      ["kindが列挙外", activity({ kind: "submit.unknown" })],
      ["commandIdがUUIDでない", activity({ commandId: "not-a-uuid" })],
      ["viewが空", activity({ view: "" })],
      ["viewに大文字", activity({ view: "S1" })],
      ["viewが33文字", activity({ view: "a".repeat(33) })],
      ["textが上限超過", activity({ text: "あ".repeat(20001) })],
      ["metaが4KB超", activity({ meta: sizedMeta("xx") })],
      ["metaが配列", activity({ meta: [1, 2, 3] })],
      // 平坦なrecordに限る——ネストや配列を許すと、PII検査が全てのstring値を
      // 漏れなく見て回る保証が持てない。
      ["metaの値がネストしたobject", activity({ meta: { nested: { a: 1 } } })],
      ["metaの値が配列", activity({ meta: { arr: [1, 2] } })],
      ["metaの値が201文字", activity({ meta: { long: "x".repeat(201) } })],
      // キーは識別子に限る。自由文を許すと、値ではなくキー側にPIIを書けてしまう——
      // boolean値のキーは値の個別検査に掛からず、JSON全体の検査も改行のエスケープで
      // すり抜けるため、入口の書式制限が唯一の防波堤になる。
      ["metaのキーが日本語（PII）", activity({ meta: { "渡辺\n三郎さん": true } })],
      ["metaのキーに空白", activity({ meta: { "a b": 1 } })],
      ["metaのキーが65文字", activity({ meta: { ["k".repeat(65)]: 1 } })],
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

    // `String.length`で測るとUTF-16のコード単位になり、日本語のmetaでは上限が
    // 実質3倍に緩む。バイト数で測っていることを境界の両側で固定する。
    // 値ごとの200文字上限があるので、キーを分けて目標バイト数へ寄せる。
    it("マルチバイトのmetaは4096バイトちょうどまで受け付け、1バイト超で拒否する", async () => {
      expect(jsonBytes(sizedMeta("x"))).toBe(4096);
      expect(jsonBytes(sizedMeta("xx"))).toBe(4097);

      const accepted = await postJson(
        "/api/teams/500109/activity",
        activity({ meta: sizedMeta("x") }),
      );
      expect(accepted.status).toBe(200);
      await expect(rows()).resolves.toHaveLength(1);

      const rejected = await postJson(
        "/api/teams/500109/activity",
        activity({
          commandId: "00000000-0000-4000-8000-0000000000a2",
          meta: sizedMeta("xx"),
        }),
      );
      expect(rejected.status).toBe(400);
      await expect(rows()).resolves.toHaveLength(1);
    });

    // schemaの検証は本文をJSONへ展開した後にしか効かない。展開前にバイト数で
    // 打ち切ることを、Content-Lengthを見る経路と実バイト数を測る経路の両方で固定する。
    it.each([
      ["Content-Lengthどおりの巨大な本文", {}],
      // ヘッダは偽装できるので、小さく申告された巨大な本文も実バイト数で弾く。
      ["Content-Lengthを小さく偽装した本文", { "Content-Length": "42" }],
    ])("64KBを超える本文(%s)は413で拒否し、行を増やさない", async (_label, headers) => {
      const huge = JSON.stringify({ ...activity(), pad: "x".repeat(65 * 1024) });
      const response = await exports.default.fetch(
        new Request("https://example.test/api/teams/500116/activity", {
          method: "POST",
          body: huge,
          // 入口ガードを通すため、ブラウザと同じくOriginを付ける。
          headers: { Origin: "https://example.test", ...headers },
        }),
      );
      expect(response.status).toBe(413);
      await expect(rows()).resolves.toEqual([]);
    });

    it("上限を超えた活動ログは429で、D1に書かない", async () => {
      const teamCode = "500170";
      const windowStartMs = 1_756_300_000_000;
      const post = (index: number): Promise<Response> =>
        handleActivityPost(
          new Request(`https://example.test/api/teams/${teamCode}/activity`, {
            method: "POST",
            headers: { Origin: "https://example.test" },
            body: JSON.stringify({ ...activity(), commandId: uniqueCommandId(index) }),
          }),
          env,
          teamCode,
          windowStartMs,
        );

      for (let index = 0; index < ACTIVITY_RATE_LIMIT_PER_MINUTE; index += 1) {
        expect((await post(index)).status, `#${String(index)}`).toBe(200);
      }
      const accepted = (await rows()).length;
      expect(accepted).toBe(ACTIVITY_RATE_LIMIT_PER_MINUTE);

      const blocked = await post(ACTIVITY_RATE_LIMIT_PER_MINUTE);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).not.toBeNull();
      await expect(rows()).resolves.toHaveLength(accepted);

      // 窓が明ければまた書ける。
      const revived = await handleActivityPost(
        new Request(`https://example.test/api/teams/${teamCode}/activity`, {
          method: "POST",
          headers: { Origin: "https://example.test" },
          body: JSON.stringify({ ...activity(), commandId: uniqueCommandId(900) }),
        }),
        env,
        teamCode,
        windowStartMs + RATE_LIMIT_WINDOW_MS,
      );
      expect(revived.status).toBe(200);
      await expect(rows()).resolves.toHaveLength(accepted + 1);
    });

    it("活動ログの枠はチャットの枠と独立している", async () => {
      const teamCode = "500171";
      const windowStartMs = 1_756_400_000_000;
      const room = env.TEAM_ROOM.getByName(teamCode);
      // チャット枠を使い切っても、活動ログは書ける。
      for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
        await room.consumeChatAttempt(windowStartMs, DEFAULT_CHAT_RATE_LIMIT, 0);
      }
      await expect(
        room.consumeChatAttempt(windowStartMs, DEFAULT_CHAT_RATE_LIMIT, 0),
      ).resolves.toMatchObject({ allowed: false });

      const response = await handleActivityPost(
        new Request(`https://example.test/api/teams/${teamCode}/activity`, {
          method: "POST",
          headers: { Origin: "https://example.test" },
          body: JSON.stringify({ ...activity(), commandId: uniqueCommandId(901) }),
        }),
        env,
        teamCode,
        windowStartMs,
      );
      expect(response.status).toBe(200);
    });

    it.each([
      ["電話番号のような文字列", "090-1234-5678"],
      ["未知の画面id", "stage3-manual"],
      ["空文字", ""],
    ])("viewが既知の画面idでない(%s)ときは400で拒否し、行を増やさない", async (_label, view) => {
      // `/^[a-z0-9-]+$/`は電話番号を通してしまい、text・metaのPIIゲートを素通りして
      // D1へ残る。画面idは有限なのでenumで固定する。
      const response = await postJson("/api/teams/500118/activity", { ...activity(), view });
      expect(response.status).toBe(400);
      await expect(rows()).resolves.toEqual([]);
    });

    it("既知の画面idは受け付ける", async () => {
      const response = await postJson("/api/teams/500119/activity", {
        ...activity(),
        view: "s35",
      });
      expect(response.status).toBe(200);
      await expect(rows()).resolves.toHaveLength(1);
    });

    it("上限以内の本文はこれまでどおり処理される", async () => {
      // 上限判定がバイト数で行われ、通常の本文を巻き込まないことの確認。
      const response = await postJson("/api/teams/500117/activity", activity());
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
  describe("PII拒否の連投", () => {
    // PII拒否はbeginChatMessageへ進まないため通常の枠消費を通らず、以前は
    // PII入りの本文を連投するだけでactivity_eventsを無限に増やせた。
    it("上限を超えたPII送信は429になり、活動ログも増えない", async () => {
      const teamCode = "500150";
      const threadId = await mainThreadId(teamCode, "00000000-0000-4000-8000-000000005150");
      const windowStartMs = 1_756_000_000_000;
      const gateway = new FakeAiGateway([]);
      const piiText = "渡辺 三郎さんの件で返信文を書いてください";
      const before = (await rows()).length;

      for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
        const response = await chat(
          teamCode,
          {
            commandId: `00000000-0000-4000-8000-${String(5200 + index).padStart(12, "0")}`,
            threadId,
            text: piiText,
          },
          gateway,
          windowStartMs,
        );
        expect(response.status, `#${String(index)}`).toBe(422);
      }
      const afterLimit = (await rows()).length;
      expect(afterLimit).toBe(before + DEFAULT_CHAT_RATE_LIMIT);

      const blocked = await chat(
        teamCode,
        {
          commandId: "00000000-0000-4000-8000-000000005300",
          threadId,
          text: piiText,
        },
        gateway,
        windowStartMs,
      );

      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).not.toBeNull();
      // 429の経路はログを書かない。
      await expect(rows()).resolves.toHaveLength(afterLimit);
      expect(gateway.requests).toHaveLength(0);
    });

    it("PII拒否で消費した枠は通常送信の枠と同じものを使う", async () => {
      const teamCode = "500151";
      const threadId = await mainThreadId(teamCode, "00000000-0000-4000-8000-000000005151");
      const windowStartMs = 1_756_100_000_000;
      const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);

      // PII拒否で上限ぶん使い切ると、正当な送信も同じ窓では通らない（二重計上せず、
      // 同じテーブル・同じ窓を共有していることの確認）。
      for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
        await chat(
          teamCode,
          {
            commandId: `00000000-0000-4000-8000-${String(5400 + index).padStart(12, "0")}`,
            threadId,
            text: "渡辺 三郎さんの件で返信文を書いてください",
          },
          gateway,
          windowStartMs,
        );
      }

      const normal = await chat(
        teamCode,
        {
          commandId: "00000000-0000-4000-8000-000000005500",
          threadId,
          text: "ふつうの本文",
        },
        gateway,
        windowStartMs,
      );
      expect(normal.status).toBe(429);
      expect(gateway.requests).toHaveLength(0);
    });
  });
});
