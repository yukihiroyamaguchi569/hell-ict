import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { chatCommandFingerprint } from "@hell-ict/domain";
import { describe, expect, it, vi } from "vitest";

import type { TeamRoom } from "../src/team-room.js";
import { session } from "./support.js";

/**
 * Characterization tests for accepting and completing a chat message (team-room split 9):
 * a rate-limited send writes nothing, and each transaction (rate limit + snapshot + pending
 * row on begin; snapshot + processed row + pending delete on complete) commits all or nothing.
 * Written against TeamRoom before the bodies moved to ChatMessages, and kept unchanged after.
 */

const GENERATION = "SELECT value FROM reset_generation WHERE id = 1";
const EXPIRE_PENDING = "DELETE FROM pending_message_commands WHERE created_at < ?";
const READ_PROCESSED =
  "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?";
const READ_PENDING =
  "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?";
const CHAT_MIGRATION_MARK = "SELECT name FROM migrations WHERE name = ?";
const READ_CHAT = "SELECT snapshot FROM chat_state WHERE id = 1";
const READ_RATE_LIMIT = "SELECT * FROM rate_limit";
const PENDING_INSERT =
  "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at, prompt_profile, fingerprint, claim_generation) VALUES (?, ?, ?, ?, ?, ?, 1)";
const PROCESSED_INSERT =
  "INSERT INTO processed_message_commands (command_id, result, fingerprint) VALUES (?, ?, ?)";

type SendCommand = { commandId: string; threadId: string; text: string };

const begin = async (
  instance: TeamRoom,
  teamCode: string,
  command: SendCommand,
  limit = 30,
): Promise<unknown> =>
  instance.beginChatMessage(
    teamCode,
    { type: "send-message", ...command },
    { nowMs: Date.now(), limit, fingerprint: await chatCommandFingerprint(command) },
  );

/** Creates the initial chat snapshot and returns its main thread. */
const mainThreadId = async (instance: TeamRoom, teamCode: string): Promise<string> => {
  const threadId = (await instance.chatSnapshot(teamCode)).threads[0]?.threadId;
  if (threadId === undefined) throw new Error("no main thread");
  return threadId;
};

/** Makes `sql.exec` throw for `failing`, runs `body`, and returns what it threw. */
const failingOn = async (
  sql: SqlStorage,
  failing: string,
  body: () => Promise<unknown>,
): Promise<unknown> => {
  const exec = sql.exec.bind(sql);
  const spy = vi.spyOn(sql, "exec").mockImplementation((query, ...bindings) => {
    if (query === failing) throw new Error("injected failure");
    return exec(query, ...bindings);
  });
  try {
    await body();
    return null;
  } catch (caught) {
    return caught;
  } finally {
    spy.mockRestore();
  }
};

describe("送信の受付（移動の前後で変わらないことの特性テスト）", () => {
  it("枠を超えた新規送信は、読むだけで何も書かずに rate-limited を返す", async () => {
    const teamCode = "400920";
    await session(teamCode);
    const result = await runInDurableObject(
      env.TEAM_ROOM.getByName(teamCode),
      async (instance, state) => {
        const threadId = await mainThreadId(instance, teamCode);
        await begin(
          instance,
          teamCode,
          { commandId: "00000000-0000-4000-8000-000000009201", threadId, text: "一通目" },
          1,
        );
        const before = {
          chat: state.storage.sql.exec(READ_CHAT).toArray(),
          rate: state.storage.sql.exec(READ_RATE_LIMIT).toArray(),
        };
        const spy = vi.spyOn(state.storage.sql, "exec");
        let outcome: unknown;
        let trace: string[];
        try {
          outcome = await begin(
            instance,
            teamCode,
            { commandId: "00000000-0000-4000-8000-000000009202", threadId, text: "二通目" },
            1,
          );
          trace = spy.mock.calls.map(([query]) => query);
        } finally {
          spy.mockRestore();
        }
        return {
          outcome,
          trace,
          before,
          after: {
            chat: state.storage.sql.exec(READ_CHAT).toArray(),
            rate: state.storage.sql.exec(READ_RATE_LIMIT).toArray(),
          },
          pending: state.storage.sql
            .exec(READ_PENDING, "00000000-0000-4000-8000-000000009202")
            .toArray(),
        };
      },
    );

    expect(result.outcome).toMatchObject({ kind: "rate-limited" });
    expect(result.trace).toEqual([
      GENERATION,
      EXPIRE_PENDING,
      READ_PROCESSED,
      READ_PENDING,
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      "SELECT count FROM rate_limit WHERE bucket = ?",
    ]);
    expect(result.after).toEqual(result.before);
    expect(result.pending).toEqual([]);
  });

  it("pending行のINSERTが失敗したら、枠もsnapshotも変わらず、例外になる", async () => {
    const teamCode = "400921";
    await session(teamCode);
    const command = { commandId: "00000000-0000-4000-8000-000000009211", text: "本文" };
    const result = await runInDurableObject(
      env.TEAM_ROOM.getByName(teamCode),
      async (instance, state) => {
        const threadId = await mainThreadId(instance, teamCode);
        const sql = state.storage.sql;
        const before = {
          chat: sql.exec(READ_CHAT).toArray(),
          rate: sql.exec(READ_RATE_LIMIT).toArray(),
        };
        const thrown = await failingOn(sql, PENDING_INSERT, () =>
          begin(instance, teamCode, { ...command, threadId }),
        );
        return {
          thrown,
          before,
          after: { chat: sql.exec(READ_CHAT).toArray(), rate: sql.exec(READ_RATE_LIMIT).toArray() },
          pending: sql.exec(READ_PENDING, command.commandId).toArray(),
        };
      },
    );

    expect(result.thrown).toBeInstanceOf(Error);
    expect(result.after).toEqual(result.before);
    expect(result.pending).toEqual([]);
  });
});

describe("応答の確定（移動の前後で変わらないことの特性テスト）", () => {
  it("processed行のINSERTが失敗したら、snapshotもpending行も変わらず、例外になる", async () => {
    const teamCode = "400922";
    await session(teamCode);
    const commandId = "00000000-0000-4000-8000-000000009221";
    const result = await runInDurableObject(
      env.TEAM_ROOM.getByName(teamCode),
      async (instance, state) => {
        const threadId = await mainThreadId(instance, teamCode);
        await begin(instance, teamCode, { commandId, threadId, text: "本文" });
        const sql = state.storage.sql;
        const before = {
          chat: sql.exec(READ_CHAT).toArray(),
          pending: sql.exec(READ_PENDING, commandId).toArray(),
        };
        const thrown = await failingOn(sql, PROCESSED_INSERT, () =>
          instance.completeChatMessage(
            commandId,
            { kind: "success", text: "応答" },
            { claimGeneration: 1, resetGeneration: 0 },
          ),
        );
        return {
          thrown,
          before,
          after: {
            chat: sql.exec(READ_CHAT).toArray(),
            pending: sql.exec(READ_PENDING, commandId).toArray(),
          },
          processed: sql.exec(READ_PROCESSED, commandId).toArray(),
        };
      },
    );

    expect(result.thrown).toBeInstanceOf(Error);
    expect(result.before.pending).toHaveLength(1);
    expect(result.after).toEqual(result.before);
    expect(result.processed).toEqual([]);
  });
});
