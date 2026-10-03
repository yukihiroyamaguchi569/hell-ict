import {
  chatMessageResultSchema,
  createThreadResultSchema,
  redactChatMessageResultPii,
  redactSnapshotPii,
} from "@hell-ict/domain";
import { z } from "zod";

/**
 * TeamRoom's one-time redaction of plaintext PII left in the stored idempotency ledgers.
 * Plain functions over the DO's storage: the migration runs synchronously inside
 * transactionSync, so nothing here may become async.
 */

/** 完了印の名前。値そのものが台帳に残るので、変えると移行がもう一度走る。 */
const LEDGER_PII_MIGRATION = "ledger-pii-redaction";

/** 全行走査で読む最小限の列。 */
const storedLedgerMigrationRowSchema = z.object({
  command_id: z.string(),
  result: z.string(),
});

/**
 * 冪等台帳に残った平文PIIを、DOに触れた最初の一度だけ全行走査して伏せ字化する。
 *
 * 読み出し時の伏せ字化（readProcessedMessage / readProcessedThread）は「再送された行」
 * しか直せない。台帳の大半は二度と再送されないので、伏せ字化を入れる前に書かれた
 * 平文はそのまま残り続ける。研修が終わってもDOのストレージに氏名が残るのは、
 * 表に出るか出ないかとは別の問題なので、行そのものを消しに行く。
 *
 * 完了印はmigrationsテーブルへ置き、二度目は1行も読まない——台帳は増え続けるので、
 * loadChatSnapshotのたびに全行を走査させるわけにはいかない。
 */
export const migrateLedgerPii = (storage: DurableObjectStorage): void => {
  const done =
    storage.sql
      .exec("SELECT name FROM migrations WHERE name = ?", LEDGER_PII_MIGRATION)
      .toArray()[0] ?? null;
  if (done !== null) return;
  storage.transactionSync(() => {
    redactLedgerTable(storage.sql, "processed_message_commands", (raw) => {
      const parsed = chatMessageResultSchema.parse(raw);
      const redacted = redactChatMessageResultPii(parsed);
      return redacted === parsed ? null : redacted;
    });
    redactLedgerTable(storage.sql, "processed_thread_commands", (raw) => {
      const parsed = createThreadResultSchema.parse(raw);
      const snapshot = redactSnapshotPii(parsed.snapshot);
      return snapshot === parsed.snapshot ? null : { snapshot };
    });
    storage.sql.exec("INSERT INTO migrations (name) VALUES (?)", LEDGER_PII_MIGRATION);
  });
};

/**
 * 台帳1テーブル分の伏せ字化。`redact`がnullを返した行（変化なし）は書き換えない。
 *
 * 壊れて読めない行はスキップする。ここで例外にすると、行が1つ壊れているだけで
 * 移行が永久に完了印を得られず、DOへ触れるたびに全行走査をやり直すことになる
 * ——壊れた行は読み出し時の検証が別途503で止めるので、二重に守る必要はない。
 */
const redactLedgerTable = (
  sql: SqlStorage,
  table: "processed_message_commands" | "processed_thread_commands",
  redact: (raw: unknown) => unknown,
): void => {
  const rows = sql
    .exec(`SELECT command_id, result FROM ${table}`)
    .toArray()
    .map((row) => storedLedgerMigrationRowSchema.safeParse(row).data)
    .filter((row) => row !== undefined);
  for (const row of rows) {
    const replacement = redactedLedgerResult(row.result, redact);
    if (replacement === null) continue;
    sql.exec(`UPDATE ${table} SET result = ? WHERE command_id = ?`, replacement, row.command_id);
  }
};

/** 保存されているJSONを伏せ字化した文字列。変化がない・読めないときはnull。 */
const redactedLedgerResult = (result: string, redact: (raw: unknown) => unknown): string | null => {
  try {
    const redacted = redact(JSON.parse(result) as unknown);
    return redacted === null ? null : JSON.stringify(redacted);
  } catch {
    return null;
  }
};
