import {
  chatMessageResultSchema,
  chatThreadIdSchema,
  createThreadResultSchema,
  promptProfileSchema,
  redactChatMessageResultPii,
  redactSnapshotPii,
} from "@hell-ict/domain";
import type {
  ChatMessageResult,
  CommandStatus,
  CreateThreadResult,
  SendMessageCommand,
} from "@hell-ict/domain";
import { z } from "zod";

import { fingerprintSchema, mismatchesFingerprint } from "./guard.js";
import type { BeginChatMessageOutcome } from "./team-room-types.js";

/**
 * TeamRoom's chat idempotency ledger (processed_message_commands, processed_thread_commands)
 * and pending rows (pending_message_commands). Plain functions over the DO's SqlStorage:
 * they stay synchronous so TeamRoom can call them inside transactionSync.
 */

/**
 * 冪等台帳の行。fingerprintは取り違え検出の要なので、型指定だけで信用しない
 * ——SQLiteは列の型を強制せず、壊れた値をそのまま渡すとmismatchesFingerprintが
 * 黙って「照合できないので通す」側へ倒れ、別内容の再送を冪等再送として受けてしまう。
 * 壊れていたら例外にし、Workerの503（時間を置いて再試行）へ倒す。
 */
const storedLedgerRowSchema = z.object({
  result: z.string(),
  fingerprint: fingerprintSchema.nullable(),
});
/**
 * pending行。SQLiteは列の型を強制しないので、読み出しも実行時に検証する。壊れた行を
 * 「pending無し」と読み替えると、既に保存済みのユーザーメッセージがもう一度積まれる
 * ——台帳行と同じく、不整合は黙って通さず503（時間を置いて再試行）へ倒す。
 */
const storedPendingMessageSchema = z.object({
  thread_id: chatThreadIdSchema,
  claimed_at: z.iso.datetime().nullable(),
  // 列を足す前に作られた行はNULL。値があるなら既知のprofileでなければならない。
  prompt_profile: promptProfileSchema.nullable(),
  fingerprint: fingerprintSchema.nullable(),
  claim_generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1)
    .nullable(),
});

export type StoredPendingMessage = z.infer<typeof storedPendingMessageSchema>;

/**
 * AI呼び出しが失敗し続け、クライアントが二度と同じcommandIdで再送しない場合に
 * pending_message_commandsが際限なく残るのを防ぐ猶予期間。研修は120分で終わる
 * 前提（企画書§3）なので、それより十分長い時間を掃除の境界にする——短すぎると、
 * 期限切れ後に同じcommandIdで本当に再送された場合、ユーザーメッセージが
 * 重複して追加されてしまう（pending行は「再送を待つ印」であり、これを消すと
 * 冪等性を失う）。1セッションの範囲では実質発生しない長さを取ることで、
 * 掃除の安全性と重複防止を両立させる。
 */
const PENDING_MESSAGE_EXPIRY_MS = 6 * 60 * 60 * 1000;

/**
 * 同一commandIdの同時リクエストがどちらもAI呼び出しへ進まないよう、pending行を
 * 「今まさに処理中」の印（claimed_at）で守る猶予期間。AiGateway自体のタイムアウト
 * （index.tsのCHAT_TIMEOUT_MS = 20秒）より十分長く取り、Worker/DOが応答を返せず
 * 終わった場合だけクレームを回収できるようにする。
 */
export const CLAIM_TIMEOUT_MS = 45 * 1000;

/** promptProfile未指定は"default"として保存・照合する（index.tsの既定と揃える）。 */
export const promptProfileOf = (command: SendMessageCommand): string =>
  command.promptProfile ?? "default";

/**
 * pending行と受信commandが同じ送信を指しているか。指紋があれば指紋だけで足りる
 * （threadId・promptProfile・本文をすべて畳んである）。指紋を持たない古い行は、
 * 従来どおりthreadIdとpromptProfileで照合する。
 */
export const mismatchesPending = (
  pending: StoredPendingMessage,
  command: SendMessageCommand,
  fingerprint: string,
): boolean => {
  if (pending.fingerprint !== null) return mismatchesFingerprint(pending.fingerprint, fingerprint);
  if (pending.thread_id !== command.threadId) return true;
  return pending.prompt_profile !== null && pending.prompt_profile !== promptProfileOf(command);
};

/**
 * processed行から冪等再送の結果を組み立てる。内容が違えば冪等再送ではないので、
 * 元の結果を返さずconflictにする——返してしまうと、クライアントは送ったつもりの
 * 本文が消えたことに気づけない。
 */
export const replayProcessed = (
  processed: { result: ChatMessageResult; fingerprint: string | null },
  fingerprint: string,
): Extract<BeginChatMessageOutcome, { kind: "conflict" | "already-processed" }> =>
  mismatchesFingerprint(processed.fingerprint, fingerprint)
    ? { kind: "conflict" }
    : { kind: "already-processed", result: processed.result };

/**
 * 送信コマンドが台帳のどこにあるか。processedにあれば完了、pendingにあれば
 * 処理中（または処理が落ちて再送待ち）、どちらにも無ければ届いていないか、
 * 猶予期間を過ぎて掃除された。DOはチーム単位なので、他チームのIDはunknownになる。
 */
export const messageCommandStatus = (sql: SqlStorage, commandId: string): CommandStatus => {
  const processed = sql
    .exec("SELECT 1 AS found FROM processed_message_commands WHERE command_id = ?", commandId)
    .toArray();
  if (processed.length > 0) return "processed";
  const pending = sql
    .exec("SELECT 1 AS found FROM pending_message_commands WHERE command_id = ?", commandId)
    .toArray();
  return pending.length > 0 ? "pending" : "unknown";
};

/**
 * 送信の冪等台帳を読む。行には当時のsnapshot全体が入るので、平文のPIIが残っていれば
 * 伏せ字化して行ごと保存し直す（chat_stateと同じ一度きりの移行）。返却値だけ
 * 伏せ字にしても、行の中の平文は次の再生でまた読まれる。
 */
export const readProcessedMessage = (
  sql: SqlStorage,
  commandId: string,
): { result: ChatMessageResult; fingerprint: string | null } | null => {
  const stored =
    sql
      .exec(
        "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?",
        commandId,
      )
      .toArray()[0] ?? null;
  if (stored === null) return null;
  const row = storedLedgerRowSchema.parse(stored);
  const parsed = chatMessageResultSchema.parse(JSON.parse(row.result) as unknown);
  const redacted = redactChatMessageResultPii(parsed);
  if (redacted !== parsed) {
    sql.exec(
      "UPDATE processed_message_commands SET result = ? WHERE command_id = ?",
      JSON.stringify(redacted),
      commandId,
    );
  }
  return { result: redacted, fingerprint: row.fingerprint };
};

/** スレッド作成の冪等台帳。readProcessedMessageと同じ理由で行ごと保存し直す。 */
export const readProcessedThread = (
  sql: SqlStorage,
  commandId: string,
): { result: CreateThreadResult; fingerprint: string | null } | null => {
  const stored =
    sql
      .exec(
        "SELECT result, fingerprint FROM processed_thread_commands WHERE command_id = ?",
        commandId,
      )
      .toArray()[0] ?? null;
  if (stored === null) return null;
  const row = storedLedgerRowSchema.parse(stored);
  const parsed = createThreadResultSchema.parse(JSON.parse(row.result) as unknown);
  const snapshot = redactSnapshotPii(parsed.snapshot);
  if (snapshot !== parsed.snapshot) {
    sql.exec(
      "UPDATE processed_thread_commands SET result = ? WHERE command_id = ?",
      JSON.stringify({ snapshot }),
      commandId,
    );
  }
  return { result: { snapshot }, fingerprint: row.fingerprint };
};

/**
 * pending行を読む。行が無ければnull。行はあるが値が壊れているときは例外にして、
 * Worker側のcatchから503へ倒す（storedPendingMessageSchemaの注記を参照）。
 */
export const readPending = (sql: SqlStorage, commandId: string): StoredPendingMessage | null => {
  const row =
    sql
      .exec(
        "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?",
        commandId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : storedPendingMessageSchema.parse(row);
};

export const expirePendingMessages = (sql: SqlStorage): void => {
  const cutoff = new Date(Date.now() - PENDING_MESSAGE_EXPIRY_MS).toISOString();
  sql.exec("DELETE FROM pending_message_commands WHERE created_at < ?", cutoff);
};

/** クレーム無し、またはクレームから十分な時間が経っていれば「取り直してよい」と判定する。 */
export const isClaimStale = (claimedAt: string | null): boolean => {
  if (claimedAt === null) return true;
  return Date.now() - new Date(claimedAt).getTime() > CLAIM_TIMEOUT_MS;
};
