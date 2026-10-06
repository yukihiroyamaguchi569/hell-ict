import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { httpErrorSchema } from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_RATE_LIMIT } from "../src/guard.js";
import { handleStageChatMessage } from "../src/stage-chat.js";
import type { TeamRoom } from "../src/team-room.js";
import { playTo } from "./game-command-support.js";
import { clock } from "./game-support.js";
import { TEST_ORIGIN } from "./support.js";
import { PII_NAME } from "./pii-support.js";

/**
 * Characterization tests for the stage chat intake and its pre-send PII gate (team-room
 * split 10). Written against TeamRoom before the bodies moved to StageChatIntake, and kept
 * unchanged after. The gate must decide before the chat snapshot is read, and a blocked
 * send must never reach the pending row (so OpenAI is never called).
 */

beforeEach(() => {
  clock.reset();
});

const GENERATION = "SELECT value FROM reset_generation WHERE id = 1";
const EXPIRE_PENDING = "DELETE FROM pending_message_commands WHERE created_at < ?";
const READ_PROCESSED =
  "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?";
const READ_PENDING =
  "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?";
const CHAT_MIGRATION_MARK = "SELECT name FROM migrations WHERE name = ?";
const READ_CHAT = "SELECT snapshot FROM chat_state WHERE id = 1";
const WRITE_CHAT = "UPDATE chat_state SET snapshot = ? WHERE id = 1";
const PENDING_INSERT =
  "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at, prompt_profile, fingerprint, claim_generation) VALUES (?, ?, ?, ?, ?, ?, 1)";
const RATE_LIMIT = [
  "SELECT count FROM rate_limit WHERE bucket = ?",
  "DELETE FROM rate_limit WHERE bucket <> ? AND bucket LIKE ?",
  "INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)",
];

const FINGERPRINT = "a".repeat(64);

const message = (text: string) => ({
  type: "stage-message",
  commandId: crypto.randomUUID(),
  generation: 0,
  text,
});

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

/** The chat tables a blocked send must leave untouched. */
const chatTables = (teamCode: string): Promise<unknown> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) =>
    ["chat_state", "pending_message_commands", "processed_message_commands"].map((table) =>
      state.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
    ),
  );

/** Calls beginStageChatMessage inside the DO and returns its outcome and the SQL it issued. */
const traceStageChat = (
  teamCode: string,
  text: string,
): Promise<{ outcome: unknown; trace: string[] }> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance: TeamRoom, state) => {
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      const outcome = await instance.beginStageChatMessage(teamCode, message(text), {
        nowMs: clock.now().getTime(),
        limit: DEFAULT_CHAT_RATE_LIMIT,
        fingerprint: FINGERPRINT,
      });
      return { outcome, trace: spy.mock.calls.map(([query]) => query) };
    } finally {
      spy.mockRestore();
    }
  });

describe("Stage 4 の送信前PIIゲート（移動の前後で変わらないことの特性テスト）", () => {
  it("個人情報を含む送信は、pending・processed・chat_state を変えず、AIを1回も呼ばない", async () => {
    const teamCode = "680001";
    await playTo(teamCode, "s4");
    const before = await chatTables(teamCode);
    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await post(teamCode, message(`${PII_NAME}さんの件`), gateway);
    expect(response.status).toBe(422);
    expect(httpErrorSchema.parse(await response.json()).code).toBe("pii_blocked");
    expect(gateway.requests).toHaveLength(0);
    expect(await chatTables(teamCode)).toEqual(before);
  });
});

describe("ステージ経路のSQL発行順（移動の前後で変わらないことの特性テスト）", () => {
  it("Stage 4 の個人情報は、会話を読む前に止め、枠だけを使う", async () => {
    const teamCode = "680002";
    await playTo(teamCode, "s4");
    const { outcome, trace } = await traceStageChat(teamCode, `${PII_NAME}さんの件`);
    expect(outcome).toMatchObject({ piiBlocked: { promptProfile: "default" } });
    expect(trace).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      GENERATION,
      "SELECT state FROM game_state WHERE id = 1",
      ...RATE_LIMIT,
    ]);
    expect(trace).not.toContain(READ_CHAT);
    expect(trace).not.toContain(PENDING_INSERT);
  });

  it("Stage 4 の個人情報の無い送信は、会話を読んでから pending 行を作る", async () => {
    const teamCode = "680003";
    await playTo(teamCode, "s4");
    const { outcome, trace } = await traceStageChat(teamCode, "発熱の一覧を整えて");
    expect(outcome).toMatchObject({ kind: "pending", route: { promptProfile: "default" } });
    expect(trace).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      GENERATION,
      "SELECT state FROM game_state WHERE id = 1",
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      ...RATE_LIMIT,
      WRITE_CHAT,
      PENDING_INSERT,
      GENERATION,
    ]);
  });

  it("Stage 5 の個人情報は、罠を枠より先に確定し、会話も pending 行も触らない", async () => {
    const teamCode = "680004";
    await playTo(teamCode, "s5");
    const { outcome, trace } = await traceStageChat(teamCode, `${PII_NAME}さんの件`);
    expect(outcome).toMatchObject({ piiBlocked: { promptProfile: "default" } });
    expect(trace).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      GENERATION,
      "SELECT state FROM game_state WHERE id = 1",
      // The trap goes through the game command ledger, before the rate limit.
      GENERATION,
      "SELECT fingerprint, outcome FROM processed_game_commands WHERE command_id = ?",
      "SELECT state FROM game_state WHERE id = 1",
      "UPDATE game_state SET state = ? WHERE id = 1",
      "INSERT INTO processed_game_commands (command_id, fingerprint, outcome) VALUES (?, ?, ?)",
      "INSERT INTO game_activity_outbox (generation, rows) VALUES (?, ?)",
      ...RATE_LIMIT,
    ]);
    expect(trace).not.toContain(READ_CHAT);
    expect(trace).not.toContain(PENDING_INSERT);
  });
});
