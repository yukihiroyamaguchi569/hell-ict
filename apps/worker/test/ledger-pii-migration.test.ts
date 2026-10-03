import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { PII_REDACTION } from "@hell-ict/domain";
import type { ChatMessage, ChatSnapshot } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { migrateLedgerPii } from "../src/ledger-pii-migration.js";
import { PII_NAME } from "./pii-support.js";

const PLAIN_PII = `${PII_NAME}さんの件、承知しました。`;
const threadId = "00000000-0000-4000-8000-00000000a001";

const message = (text: string): ChatMessage => ({
  messageId: "00000000-0000-4000-8000-00000000a002",
  role: "assistant",
  text,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const snapshotWith = (text: string): ChatSnapshot => ({
  teamCode: "400100",
  revision: 1,
  threads: [{ threadId, title: "メイン", messages: [message(text)] }],
});

const messageResult = (text: string): string =>
  JSON.stringify({ snapshot: snapshotWith(text), assistant: message(text) });

const threadResult = (text: string): string => JSON.stringify({ snapshot: snapshotWith(text) });

type LedgerRow = { command_id: string; result: string };

/**
 * Runs `body` against a TeamRoom's real storage. Only the constructor runs, so the tables
 * exist and the migration has not been marked done yet.
 */
const withStorage = <T>(name: string, body: (storage: DurableObjectStorage) => T): Promise<T> =>
  runInDurableObject(env.TEAM_ROOM.getByName(name), (_instance, state) => body(state.storage));

const insert = (storage: DurableObjectStorage, table: string, rows: LedgerRow[]): void => {
  for (const row of rows) {
    storage.sql.exec(
      `INSERT INTO ${table} (command_id, result) VALUES (?, ?)`,
      row.command_id,
      row.result,
    );
  }
};

const resultsOf = (storage: DurableObjectStorage, table: string): Record<string, string> =>
  Object.fromEntries(
    storage.sql
      .exec(`SELECT command_id, result FROM ${table}`)
      .toArray()
      .map((row) => [String(row.command_id), String(row.result)]),
  );

const migrationMarks = (storage: DurableObjectStorage): string[] =>
  storage.sql
    .exec("SELECT name FROM migrations")
    .toArray()
    .map((row) => String(row.name));

describe("migrateLedgerPii（保存済み台帳の伏せ字化）", () => {
  it("両方の台帳の平文PIIを伏せ字にし、完了印を1つ残す", async () => {
    const result = await withStorage("ledger-pii-001", (storage) => {
      insert(storage, "processed_message_commands", [
        { command_id: "m1", result: messageResult(PLAIN_PII) },
      ]);
      insert(storage, "processed_thread_commands", [
        { command_id: "t1", result: threadResult(PLAIN_PII) },
      ]);
      migrateLedgerPii(storage);
      return {
        messages: resultsOf(storage, "processed_message_commands"),
        threads: resultsOf(storage, "processed_thread_commands"),
        marks: migrationMarks(storage),
      };
    });

    for (const stored of [result.messages.m1, result.threads.t1]) {
      expect(stored).not.toContain(PII_NAME);
      expect(stored).toContain(PII_REDACTION);
    }
    expect(result.marks).toEqual(["ledger-pii-redaction"]);
  });

  it("PIIの無い行は書き換えない（保存されている文字列のまま）", async () => {
    const original = messageResult("承知しました。");
    const result = await withStorage("ledger-pii-002", (storage) => {
      insert(storage, "processed_message_commands", [{ command_id: "m1", result: original }]);
      migrateLedgerPii(storage);
      return resultsOf(storage, "processed_message_commands");
    });

    expect(result.m1).toBe(original);
  });

  it("読めない行は飛ばし、ほかの行の伏せ字化と完了印は進める", async () => {
    const result = await withStorage("ledger-pii-003", (storage) => {
      insert(storage, "processed_message_commands", [
        { command_id: "broken-json", result: "{" },
        { command_id: "wrong-shape", result: JSON.stringify({ text: PLAIN_PII }) },
        { command_id: "m1", result: messageResult(PLAIN_PII) },
      ]);
      migrateLedgerPii(storage);
      return {
        messages: resultsOf(storage, "processed_message_commands"),
        marks: migrationMarks(storage),
      };
    });

    expect(result.messages["broken-json"]).toBe("{");
    expect(result.messages["wrong-shape"]).toBe(JSON.stringify({ text: PLAIN_PII }));
    expect(result.messages.m1).toContain(PII_REDACTION);
    expect(result.marks).toEqual(["ledger-pii-redaction"]);
  });

  it("完了印があれば2回目は1行も書き換えない", async () => {
    const result = await withStorage("ledger-pii-004", (storage) => {
      migrateLedgerPii(storage);
      insert(storage, "processed_message_commands", [
        { command_id: "m1", result: messageResult(PLAIN_PII) },
      ]);
      migrateLedgerPii(storage);
      return {
        messages: resultsOf(storage, "processed_message_commands"),
        marks: migrationMarks(storage),
      };
    });

    expect(result.messages.m1).toContain(PII_NAME);
    expect(result.marks).toEqual(["ledger-pii-redaction"]);
  });
});
