import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createThreadFingerprint } from "@hell-ict/domain";
import { describe, expect, it, vi } from "vitest";

import type { TeamRoom } from "../src/team-room.js";
import { session } from "./support.js";

/**
 * Characterization tests for thread creation (team-room split 8): the SQL statements it
 * issues, in order, and that the snapshot and the ledger are written together or not at all.
 * Written against TeamRoom before the body moved to ChatStore, and kept unchanged after.
 */

const LEDGER_INSERT =
  "INSERT INTO processed_thread_commands (command_id, result, fingerprint) VALUES (?, ?, ?)";
const GENERATION = "SELECT value FROM reset_generation WHERE id = 1";
const READ_LEDGER =
  "SELECT result, fingerprint FROM processed_thread_commands WHERE command_id = ?";
const CHAT_MIGRATION_MARK = "SELECT name FROM migrations WHERE name = ?";
const READ_CHAT = "SELECT snapshot FROM chat_state WHERE id = 1";
const WRITE_CHAT = "UPDATE chat_state SET snapshot = ? WHERE id = 1";

type ThreadCommand = { commandId: string; title: string; kind: "manual" | "stage" };

const create = async (instance: TeamRoom, teamCode: string, command: ThreadCommand) =>
  instance.createThread(
    teamCode,
    { type: "create-thread", generation: 0, ...command },
    await createThreadFingerprint(command),
  );

/** Runs `body` inside the DO and returns the SQL statements it issued, in order. */
const traceSql = (
  teamCode: string,
  body: (instance: TeamRoom) => Promise<unknown>,
): Promise<string[]> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance, state) => {
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      await body(instance);
      return spy.mock.calls.map(([query]) => query);
    } finally {
      spy.mockRestore();
    }
  });

describe("スレッド作成のSQL発行順（移動の前後で変わらないことの特性テスト）", () => {
  it("新規作成・同じcommandIdの再送・同名ステージスレッドへの作成で、同じ順にSQLを発行する", async () => {
    const teamCode = "400910";
    await session(teamCode);
    const manual: ThreadCommand = {
      commandId: "00000000-0000-4000-8000-000000009101",
      title: "副",
      kind: "manual",
    };
    const stage: ThreadCommand = {
      commandId: "00000000-0000-4000-8000-000000009102",
      title: "ステージ",
      kind: "stage",
    };
    const stageAgain: ThreadCommand = {
      ...stage,
      commandId: "00000000-0000-4000-8000-000000009103",
    };

    const fresh = await traceSql(teamCode, (instance) => create(instance, teamCode, manual));
    const replay = await traceSql(teamCode, (instance) => create(instance, teamCode, manual));
    await traceSql(teamCode, (instance) => create(instance, teamCode, stage));
    const existingStage = await traceSql(teamCode, (instance) =>
      create(instance, teamCode, stageAgain),
    );

    // The first chat read of the team also runs the one-off PII migration and creates the
    // initial snapshot, before the thread is written.
    expect(fresh).toEqual([
      GENERATION,
      READ_LEDGER,
      CHAT_MIGRATION_MARK,
      "SELECT command_id, result FROM processed_message_commands",
      "SELECT command_id, result FROM processed_thread_commands",
      "INSERT INTO migrations (name) VALUES (?)",
      READ_CHAT,
      "INSERT INTO chat_state (id, snapshot) VALUES (1, ?)",
      WRITE_CHAT,
      LEDGER_INSERT,
    ]);
    expect(replay).toEqual([GENERATION, READ_LEDGER]);
    expect(existingStage).toEqual([
      GENERATION,
      READ_LEDGER,
      CHAT_MIGRATION_MARK,
      READ_CHAT,
      "INSERT OR IGNORE INTO processed_thread_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
    ]);
  });
});

describe("スレッド作成の書き込みは snapshot と台帳が同時に成立する", () => {
  it("台帳のINSERTが失敗したら、snapshotも台帳も変わらず、例外になる", async () => {
    const teamCode = "400911";
    await session(teamCode);
    const command: ThreadCommand = {
      commandId: "00000000-0000-4000-8000-000000009111",
      title: "副",
      kind: "manual",
    };

    const outcome = await runInDurableObject(
      env.TEAM_ROOM.getByName(teamCode),
      async (instance, state) => {
        // Create the initial chat snapshot first, so only the thread write is under test.
        await instance.chatSnapshot(teamCode);
        const sql = state.storage.sql;
        const before = sql.exec(READ_CHAT).toArray();
        const exec = sql.exec.bind(sql);
        const spy = vi.spyOn(sql, "exec").mockImplementation((query, ...bindings) => {
          if (query === LEDGER_INSERT) throw new Error("injected ledger failure");
          return exec(query, ...bindings);
        });
        let thrown: unknown = null;
        try {
          await create(instance, teamCode, command);
        } catch (caught) {
          thrown = caught;
        } finally {
          spy.mockRestore();
        }
        return {
          thrown,
          before,
          after: sql.exec(READ_CHAT).toArray(),
          ledger: sql.exec(READ_LEDGER, command.commandId).toArray(),
        };
      },
    );

    expect(outcome.thrown).toBeInstanceOf(Error);
    expect(outcome.after).toEqual(outcome.before);
    expect(outcome.ledger).toEqual([]);
  });
});
