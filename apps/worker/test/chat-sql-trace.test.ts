import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { chatCommandFingerprint, createThreadResultSchema } from "@hell-ict/domain";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_RATE_LIMIT } from "../src/guard.js";
import type { TeamRoom } from "../src/team-room.js";
import { postJson, session } from "./support.js";

/**
 * Characterization test: pins the order of SQL statements the chat paths issue, so that
 * moving code out of TeamRoom (team-room split 7+) cannot silently reorder or drop a
 * read or write. Only the statement text is recorded; bound values (timestamps, ids)
 * vary per run.
 */

const teamCode = "400900";

const createThreadId = async (): Promise<string> => {
  await session(teamCode);
  const response = await postJson(`/api/teams/${teamCode}/chat/threads`, {
    type: "create-thread",
    commandId: "00000000-0000-4000-8000-000000009001",
    title: "副",
  });
  const threadId = createThreadResultSchema.parse(await response.json()).snapshot.threads[1]
    ?.threadId;
  if (threadId === undefined) throw new Error("thread was not created");
  return threadId;
};

/** Runs `body` inside the DO and returns the SQL statements it issued, in order. */
const traceSql = (body: (instance: TeamRoom) => Promise<unknown>): Promise<string[]> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance, state) => {
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      await body(instance);
      return spy.mock.calls.map(([query]) => query);
    } finally {
      spy.mockRestore();
    }
  });

const begin = async (instance: TeamRoom, command: SendCommand): Promise<unknown> =>
  instance.beginChatMessage(
    teamCode,
    { type: "send-message", ...command },
    {
      nowMs: Date.now(),
      limit: DEFAULT_CHAT_RATE_LIMIT,
      fingerprint: await chatCommandFingerprint(command),
    },
  );

type SendCommand = { commandId: string; threadId: string; text: string };

const GENERATION = "SELECT value FROM reset_generation WHERE id = 1";
const EXPIRE_PENDING = "DELETE FROM pending_message_commands WHERE created_at < ?";
const READ_PROCESSED =
  "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?";
const READ_PENDING =
  "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?";
const CHAT_MIGRATION_MARK = "SELECT name FROM migrations WHERE name = ?";
const READ_CHAT = "SELECT snapshot FROM chat_state WHERE id = 1";
const WRITE_CHAT = "UPDATE chat_state SET snapshot = ? WHERE id = 1";
const RATE_LIMIT = [
  "SELECT count FROM rate_limit WHERE bucket = ?",
  "DELETE FROM rate_limit WHERE bucket <> ? AND bucket LIKE ?",
  "INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)",
];

describe("チャット経路のSQL発行順（移動の前後で変わらないことの特性テスト）", () => {
  it("新規送信・完了・失敗後の再開で、同じ順にSQLを発行する", async () => {
    const threadId = await createThreadId();
    const first: SendCommand = {
      commandId: "00000000-0000-4000-8000-000000009002",
      threadId,
      text: "本文",
    };
    const second: SendCommand = {
      commandId: "00000000-0000-4000-8000-000000009003",
      threadId,
      text: "二通目",
    };

    const fresh = await traceSql((instance) => begin(instance, first));
    const complete = await traceSql((instance) =>
      instance.completeChatMessage(
        first.commandId,
        { kind: "success", text: "応答" },
        { claimGeneration: 1, resetGeneration: 0 },
      ),
    );
    // A failed completion releases the claim, so the next begin takes the resume path.
    await traceSql(async (instance) => {
      await begin(instance, second);
      await instance.completeChatMessage(
        second.commandId,
        { kind: "failure" },
        { claimGeneration: 1, resetGeneration: 0 },
      );
    });
    const resume = await traceSql((instance) => begin(instance, second));

    expect(fresh).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      ...RATE_LIMIT,
      WRITE_CHAT,
      "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at, prompt_profile, fingerprint, claim_generation) VALUES (?, ?, ?, ?, ?, ?, 1)",
      GENERATION,
    ]);
    expect(complete).toEqual([
      GENERATION,
      READ_PROCESSED,
      READ_PENDING,
      READ_CHAT,
      WRITE_CHAT,
      "INSERT INTO processed_message_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
      "DELETE FROM pending_message_commands WHERE command_id = ?",
    ]);
    expect(resume).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      ...RATE_LIMIT,
      "UPDATE pending_message_commands SET claimed_at = ?, claim_generation = ? WHERE command_id = ?",
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      GENERATION,
    ]);
  });
});
