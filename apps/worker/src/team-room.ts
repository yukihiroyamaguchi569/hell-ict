import {
  appendMessage,
  applyCheckpoint,
  chatMessageResultSchema,
  chatMessageSchema,
  chatSnapshotSchema,
  checkpointSnapshotSchema,
  commandResultSchema,
  countThreadsOfKind,
  createThread as domainCreateThread,
  createThreadCommandSchema,
  createThreadResultSchema,
  initialChatSnapshot,
  initialTeamSnapshot,
  normalizeAssistantText,
  saveCheckpointCommandSchema,
  sendMessageCommandSchema,
  teamCodeSchema,
  teamCommandSchema,
  teamSnapshotSchema,
  teamSyncMessageSchema,
  transitionTeam,
} from "@hell-ict/domain";
import type {
  AiMessage,
  ChatMessage,
  ChatMessageResult,
  ChatSnapshot,
  ChatThreadKind,
  CheckpointRejectionReason,
  CheckpointSnapshot,
  CommandResult,
  CreateThreadCommand,
  CreateThreadResult,
  SaveCheckpointCommand,
  SendMessageCommand,
  TeamCode,
  TeamSnapshot,
  TeamSyncMessage,
} from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  beginChatGateSchema,
  claimGenerationSchema,
  fingerprintSchema,
  nowMsSchema,
  RATE_LIMIT_WINDOW_MS,
  rateLimitBucket,
  rateLimitCountSchema,
  rateLimitRetryAfterSeconds,
} from "./guard.js";
import { error, isWebSocketRequest } from "./http.js";

type StoredCommand = { result: string };
type StoredState = { snapshot: string };
type StoredChatState = { snapshot: string };
type StoredThreadCommand = { result: string; fingerprint: string | null };
type StoredMessageCommand = { result: string; fingerprint: string | null };
type StoredPendingMessage = {
  thread_id: string;
  claimed_at: string | null;
  prompt_profile: string | null;
  fingerprint: string | null;
  claim_generation: number | null;
};
type StoredCheckpointState = { snapshot: string };
type StoredCheckpointCommand = { revision: SqlStorageValue; fingerprint: string | null };
type ConflictReply = { conflict: true };
type UnknownThreadReply = { unknownThread: true };

/** チェックポイント保存の拒否理由。Workerが理由ごとに409の文言を分ける。 */
export type CheckpointRejection = { rejected: CheckpointRejectionReason };

/**
 * transactionSyncを巻き戻すためだけの内部シグナル。CASが0行だったことを
 * 例外として伝え、saveCheckpointの外でconflictへ写す。DOの外へは漏らさない。
 */
class CheckpointConflictError extends Error {}

/** スレッド上限に達した作成要求。DOには何も保存しない。kindごとに文言を変える。 */
export type ThreadLimitReply = { threadLimit: true; max: number; kind: ChatThreadKind };

export type BeginChatMessageOutcome =
  | { kind: "already-processed"; result: ChatMessageResult }
  | { kind: "pending"; history: AiMessage[]; claimGeneration: number }
  | { kind: "in-progress" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  // 同じcommandIdが別のスレッド／別のpromptProfileで使い回された。冪等再送ではなく
  // クライアント側の取り違えなので、pendingを流用せず409で突き返す。
  | { kind: "conflict" };

export type CompleteChatMessageOutcome = { kind: "success"; text: string } | { kind: "failure" };

/** レート制限の用途。同じテーブル・同じ固定窓を、接頭辞で分けて数える。 */
type RateLimitKind = "chat" | "activity";

/** consumeChatAttempt / consumeActivityAttemptの判定。超過なら待つべき秒数を返す。 */
export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

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
const CLAIM_TIMEOUT_MS = 45 * 1000;

/**
 * 1チームが持てるスレッド数の上限。kindごとに独立して数える——上限を1本にすると、
 * 手動スレッドを作りすぎたチームがステージ進行そのものを止めてしまう。
 * どちらもDOのストレージが際限なく膨らむのを防ぐための粗い上限である。
 */
export const MAX_MANUAL_THREADS_PER_TEAM = 25;
/** ステージが自動で開く5本に、改名・再設計の余裕を足した値。 */
export const MAX_STAGE_THREADS_PER_TEAM = 8;

const THREAD_LIMITS: Readonly<Record<ChatThreadKind, number>> = {
  manual: MAX_MANUAL_THREADS_PER_TEAM,
  stage: MAX_STAGE_THREADS_PER_TEAM,
};

/** rate_limitの行。壊れた値でレート制限が黙って無効化されないよう実行時に検証する。 */
const storedRateLimitSchema = z.object({ count: z.number().int().nonnegative() });

/** promptProfile未指定は"default"として保存・照合する（index.tsの既定と揃える）。 */
const promptProfileOf = (command: SendMessageCommand): string => command.promptProfile ?? "default";

/**
 * beginChatMessageへ渡す、コマンド本体以外の入力。fingerprintの計算はWebCryptoで
 * 非同期なのでWorker側で済ませて渡す——DOの中でawaitすると、その隙に同じcommandIdの
 * 別リクエストが入り込み、冪等判定と枠消費が二重に走りうる。
 */
export type BeginChatMessageGate = {
  readonly nowMs: number;
  readonly limit: number;
  readonly fingerprint: string;
};

/**
 * 記録済みの指紋と受信commandが同じ内容を指しているか。指紋を持たない行
 * （この列を足す前に作られたもの）は照合をスキップする——古い行を理由に正当な
 * 再送を弾かないことを優先する。
 */
const mismatchesFingerprint = (stored: string | null, fingerprint: string): boolean =>
  stored !== null && stored !== fingerprint;

/**
 * pending行と受信commandが同じ送信を指しているか。指紋があれば指紋だけで足りる
 * （threadId・promptProfile・本文をすべて畳んである）。指紋を持たない古い行は、
 * 従来どおりthreadIdとpromptProfileで照合する。
 */
const mismatchesPending = (
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
const replayProcessed = (
  processed: StoredMessageCommand,
  fingerprint: string,
): BeginChatMessageOutcome => {
  if (mismatchesFingerprint(processed.fingerprint, fingerprint)) return { kind: "conflict" };
  return {
    kind: "already-processed",
    result: chatMessageResultSchema.parse(JSON.parse(processed.result) as unknown),
  };
};

/**
 * 応答をsnapshotへ載せられる形へ整える。失敗と、載せられない応答（空白だけ）は
 * どちらもnullへ畳む——空の本文をsnapshotへ積むと、以後そのスレッドの読み出しが
 * parse失敗で丸ごと壊れる。上限超過はnormalizeAssistantTextが切り詰める。
 */
const assistantTextOf = (outcome: CompleteChatMessageOutcome): string | null =>
  outcome.kind === "success" ? normalizeAssistantText(outcome.text) : null;

export class TeamRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS team_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chat_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_thread_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL, fingerprint TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_message_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL, fingerprint TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending_message_commands (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, claimed_at TEXT, prompt_profile TEXT, fingerprint TEXT, claim_generation INTEGER NOT NULL DEFAULT 0)",
    );
    // 既にテーブルを持つDOにはCREATE TABLE IF NOT EXISTSが効かないので、列を後から足す。
    // 2度目以降は「列が既にある」で失敗するだけなので握りつぶす。既存行のprompt_profileは
    // NULLになり、照合をスキップする（下のmismatchesPending）。
    for (const statement of [
      "ALTER TABLE pending_message_commands ADD COLUMN prompt_profile TEXT",
      "ALTER TABLE pending_message_commands ADD COLUMN fingerprint TEXT",
      "ALTER TABLE processed_message_commands ADD COLUMN fingerprint TEXT",
      "ALTER TABLE pending_message_commands ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE processed_thread_commands ADD COLUMN fingerprint TEXT",
      "ALTER TABLE processed_checkpoint_commands ADD COLUMN fingerprint TEXT",
    ]) {
      try {
        this.ctx.storage.sql.exec(statement);
      } catch {
        // 列が既に存在する。
      }
    }
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS checkpoint_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_checkpoint_commands (command_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rate_limit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL)",
    );
  }

  // ---- チーム状態（P1Bから継続） ----

  async join(teamCodeInput: unknown): Promise<TeamSnapshot> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const stored =
      this.ctx.storage.sql
        .exec<StoredState>("SELECT snapshot FROM team_state WHERE id = 1")
        .toArray()[0] ?? null;
    if (stored !== null) return teamSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    const snapshot = initialTeamSnapshot(teamCode);
    this.ctx.storage.sql.exec(
      "INSERT INTO team_state (id, snapshot) VALUES (1, ?)",
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  async command(
    teamCodeInput: unknown,
    commandInput: unknown,
  ): Promise<CommandResult | ConflictReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command = teamCommandSchema.parse(commandInput);
    const saved =
      this.ctx.storage.sql
        .exec<StoredCommand>(
          "SELECT result FROM processed_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (saved !== null)
      return this.repairLeaderboard(
        commandResultSchema.parse(JSON.parse(saved.result) as unknown),
        command.commandId,
      );
    const transition = transitionTeam(await this.join(teamCode), command);
    if (!transition.ok) return { conflict: true };
    const pending = commandResultSchema.parse({
      snapshot: transition.snapshot,
      applied: true,
      leaderboardPending: true,
    });
    const written = this.ctx.storage.sql.exec(
      "UPDATE team_state SET snapshot = ? WHERE id = 1 AND json_extract(snapshot, '$.revision') = ?",
      JSON.stringify(pending.snapshot),
      command.expectedRevision,
    ).rowsWritten;
    if (written === 0) return { conflict: true };
    this.ctx.storage.sql.exec(
      "INSERT INTO processed_commands (command_id, result) VALUES (?, ?)",
      command.commandId,
      JSON.stringify(pending),
    );
    return this.repairLeaderboard(pending, command.commandId);
  }

  // ---- チャット ----

  private loadChatSnapshot(teamCode: TeamCode): ChatSnapshot {
    const stored =
      this.ctx.storage.sql
        .exec<StoredChatState>("SELECT snapshot FROM chat_state WHERE id = 1")
        .toArray()[0] ?? null;
    if (stored !== null) return chatSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    const snapshot = initialChatSnapshot(teamCode, crypto.randomUUID());
    this.ctx.storage.sql.exec(
      "INSERT INTO chat_state (id, snapshot) VALUES (1, ?)",
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  private saveChatSnapshot(snapshot: ChatSnapshot): void {
    this.ctx.storage.sql.exec(
      "UPDATE chat_state SET snapshot = ? WHERE id = 1",
      JSON.stringify(snapshot),
    );
  }

  async chatSnapshot(teamCodeInput: unknown): Promise<ChatSnapshot> {
    return this.loadChatSnapshot(teamCodeSchema.parse(teamCodeInput));
  }

  async createThread(
    teamCodeInput: unknown,
    commandInput: unknown,
    fingerprintInput: unknown,
  ): Promise<CreateThreadResult | ThreadLimitReply | ConflictReply> {
    const fingerprint = fingerprintSchema.parse(fingerprintInput);
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: CreateThreadCommand = createThreadCommandSchema.parse(commandInput);
    const saved =
      this.ctx.storage.sql
        .exec<StoredThreadCommand>(
          "SELECT result, fingerprint FROM processed_thread_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (saved !== null) {
      // 同じcommandIdで別のタイトル・別のkindを送る取り違えは冪等再送ではない。
      if (mismatchesFingerprint(saved.fingerprint, fingerprint)) return { conflict: true };
      return createThreadResultSchema.parse(JSON.parse(saved.result) as unknown);
    }
    const snapshot = this.loadChatSnapshot(teamCode);
    // 冪等再送（processed済み）は上限に関係なく従来の結果を返す。上限を当てるのは
    // 新しいスレッドを実際に増やすときだけである。kindごとに独立して数える。
    const max = THREAD_LIMITS[command.kind];
    if (countThreadsOfKind(snapshot, command.kind) >= max) {
      return { threadLimit: true, max, kind: command.kind };
    }
    const created = domainCreateThread(snapshot, {
      threadId: crypto.randomUUID(),
      title: command.title,
      kind: command.kind,
    });
    if (!created.ok) throw new Error("スレッドの作成に失敗しました。");
    this.saveChatSnapshot(created.snapshot);
    const result = createThreadResultSchema.parse({ snapshot: created.snapshot });
    this.ctx.storage.sql.exec(
      "INSERT INTO processed_thread_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
      command.commandId,
      JSON.stringify(result),
      fingerprint,
    );
    this.broadcastChat(created.snapshot);
    return result;
  }

  /**
   * 固定窓の枠を1つ消費する。消費できたらnull、超過していたら待つべき秒数を返す。
   *
   * beginChatMessageの中からだけ呼ぶ。以前は別RPCとしてWorkerから先に呼んでいたが、
   * それだと「枠の予約」と「pending行の作成」が別々のDO操作になり、同じcommandIdの
   * 並行再送が二重に枠を減らした。1操作にまとめると、DOの直列実行がそのまま
   * 「数えるのは新しいpending行を作るときだけ」を保証する。
   *
   * `nowMs`はWorkerから渡す。DO内でDate.now()を直書きすると窓をテストから固定できない。
   */
  private consumeRateLimit(kind: RateLimitKind, nowMs: number, limit: number): number | null {
    // 用途ごとに接頭辞を付けて枠を分ける。チャットと活動ログを同じ枠で数えると、
    // ログが詰まってゲーム操作が止まる（あるいはその逆）ことになる。
    const bucket = `${kind}:${rateLimitBucket(nowMs, RATE_LIMIT_WINDOW_MS)}`;
    const count = this.rateLimitCount(bucket);
    if (count >= limit) return rateLimitRetryAfterSeconds(nowMs, RATE_LIMIT_WINDOW_MS);
    // 固定窓なので過去の窓の行は不要。消費するときに掃除して用途ごとに1行だけ残す
    // （超過で戻るときは1行も書かないよう、判定より後に置く）。
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_limit WHERE bucket <> ? AND bucket LIKE ?",
      bucket,
      `${kind}:%`,
    );
    // `count + 1`ではなく読み取った値からの上書きにする。壊れた行へ加算し続けると
    // 上限へ永久に届かず、制限が黙って無効化される。
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)",
      bucket,
      count + 1,
    );
    return null;
  }

  /**
   * 現在の窓のカウンタを読む。行が無い、または値が壊れている（型が違う、負数）ときは0を返す。
   *
   * 自前で書いている行だが、SQLiteは列の型を強制しないので、手作業のSQLや将来の
   * スキーマ変更で数値以外が入りうる。素通しするとNaNとの比較が常にfalseになり、
   * レート制限が例外もログも出さずに効かなくなる。壊れた行は0として扱い、
   * consumeRateLimitの上書きで正しい値へ戻す。
   */
  private rateLimitCount(bucket: string): number {
    const row =
      this.ctx.storage.sql
        .exec("SELECT count FROM rate_limit WHERE bucket = ?", bucket)
        .toArray()[0] ?? null;
    if (row === null) return 0;
    return storedRateLimitSchema.safeParse(row).data?.count ?? 0;
  }

  /**
   * 送信前PIIゲートで拒否する送信のために、レート制限の枠を1つだけ消費する。
   *
   * PII拒否はbeginChatMessageへ進まないため通常の枠消費を通らず、PII入りの本文を
   * 連投するだけで活動ログ（activity_events）を無限に増やせてしまう。beginChatMessageと
   * 同じテーブル・同じ窓を使い、二重計上にならないよう「PII拒否経路はこれだけ、
   * 通常経路はbeginChatMessageだけ」が枠を消費する分担にする。
   */
  async consumeChatAttempt(nowMs: unknown, limit: unknown): Promise<RateLimitVerdict> {
    const retryAfterSeconds = this.consumeRateLimit(
      "chat",
      nowMsSchema.parse(nowMs),
      rateLimitCountSchema.parse(limit),
    );
    return retryAfterSeconds === null ? { allowed: true } : { allowed: false, retryAfterSeconds };
  }

  /**
   * 活動ログ1件ぶんの枠を消費する。POST /api/teams/:code/activity には回数制限が
   * 無く、1チームがD1のactivity_eventsを無制限に増やせた。チャットとは別の枠で
   * 数える（同じテーブル・同じ固定窓、接頭辞だけ違う）。
   */
  async consumeActivityAttempt(nowMs: unknown, limit: unknown): Promise<RateLimitVerdict> {
    const retryAfterSeconds = this.consumeRateLimit(
      "activity",
      nowMsSchema.parse(nowMs),
      rateLimitCountSchema.parse(limit),
    );
    return retryAfterSeconds === null ? { allowed: true } : { allowed: false, retryAfterSeconds };
  }

  /**
   * 送信を受け付け、AIへ渡す履歴を返す。レート制限の消費もここで行う——判定と
   * pending行の作成を1つのDO操作にまとめることで、次の3つを同時に保証する。
   *
   * - 冪等再送（processed済み・pending残り）は枠を消費しない。通信が不安定で再送を
   *   繰り返しているチームが、1通も新しく送っていないのに429で詰むのを避ける。
   * - 存在しないthreadIdへの送信は枠を消費しない。不正なリクエストで正規の枠を
   *   削れてしまうのを避ける。
   * - 枠を消費するのは、新しいpending行を実際に作る直前だけ。DOは操作を直列に
   *   実行するので、同じcommandIdの並行再送が二重に数えられることはない。
   *
   * 超過したときはユーザーメッセージを保存せず（saveChatSnapshotより手前で返す）、
   * 呼び出し側もAiGatewayに触れない。
   */
  async beginChatMessage(
    teamCodeInput: unknown,
    commandInput: unknown,
    gate: unknown,
  ): Promise<BeginChatMessageOutcome | UnknownThreadReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: SendMessageCommand = sendMessageCommandSchema.parse(commandInput);
    const validated = beginChatGateSchema.parse(gate);
    const { nowMs, limit, fingerprint } = validated;
    this.expirePendingMessages();
    const processed =
      this.ctx.storage.sql
        .exec<StoredMessageCommand>(
          "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (processed !== null) return replayProcessed(processed, fingerprint);

    const pending =
      this.ctx.storage.sql
        .exec<StoredPendingMessage>(
          "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (pending !== null) return this.resumePending(teamCode, command, pending, validated);

    const snapshot = this.loadChatSnapshot(teamCode);
    if (!snapshot.threads.some((thread) => thread.threadId === command.threadId)) {
      return { unknownThread: true };
    }
    const userMessage: ChatMessage = {
      messageId: crypto.randomUUID(),
      role: "user",
      text: command.text,
      createdAt: new Date().toISOString(),
    };
    const appended = appendMessage(snapshot, { threadId: command.threadId, message: userMessage });
    if (!appended.ok) return { unknownThread: true };
    // ここまでは何も永続化していない。「枠の加算・snapshotの保存・pending行の作成」は
    // 全部そろって初めて意味を持つので、1つのトランザクションにまとめる。途中で
    // ストレージが失敗しても、枠だけ減ってメッセージが残らない中途半端な状態にしない。
    // 超過のときはconsumeRateLimitが1行も書かずに戻るため、この中では何も起きない。
    const retryAfterSeconds = this.ctx.storage.transactionSync(() => {
      const retry = this.consumeRateLimit("chat", nowMs, limit);
      if (retry !== null) return retry;
      this.saveChatSnapshot(appended.snapshot);
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at, prompt_profile, fingerprint, claim_generation) VALUES (?, ?, ?, ?, ?, ?, 1)",
        command.commandId,
        command.threadId,
        now,
        now,
        promptProfileOf(command),
        fingerprint,
      );
      return null;
    });
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    this.broadcastChat(appended.snapshot);
    return {
      kind: "pending",
      history: this.historyFor(appended.snapshot, command.threadId),
      claimGeneration: 1,
    };
  }

  /**
   * 既にpending行が残っているcommandIdの再送を捌く。クレームが生きていれば処理中、
   * 古ければ取り直して履歴を返す。どちらも新しい送信ではないので枠は消費しない。
   * beginChatMessageの複雑度を下げるための切り出し。
   */
  private resumePending(
    teamCode: TeamCode,
    command: SendMessageCommand,
    pending: StoredPendingMessage,
    gate: BeginChatMessageGate,
  ): BeginChatMessageOutcome {
    // 同じcommandIdを別の内容（別スレッド／別profile／別本文）で使い回した送信は、
    // 冪等再送ではなくクライアント側の取り違えである。pendingの履歴を流用すると、
    // 別スレッドの文脈をそのままAIへ渡してしまうので、流用せずに突き返す。
    if (mismatchesPending(pending, command, gate.fingerprint)) return { kind: "conflict" };
    if (!this.isClaimStale(pending.claimed_at)) return { kind: "in-progress" };
    // ここから先はこれから改めてOpenAIを呼ぶ経路なので、新規送信と同じく枠を1つ消費する。
    // completeChatMessageはAI失敗・refusalでクレームを解放するため、消費しないと
    // 「失敗する本文を同じcommandIdで投げ続ける」だけでレート制限に一切当たらず
    // OpenAIを何度でも呼べてしまう。AIを呼ばない再送——processed（結果を返すだけ）と
    // クレームが生きている最中（in-progress）——は従来どおり消費しない。
    const retryAfterSeconds = this.consumeRateLimit("chat", gate.nowMs, gate.limit);
    // 超過してもpending行は消さない。ユーザー発言は既に保存済みで、行を消すと
    // 同じcommandIdの再送が新規送信として二重に積まれる（冪等性を失う）。
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    // 未クレーム、またはクレームが古い（AI呼び出しが完了しないまま終わった）ので、
    // ここで改めてクレームを取り直してから再試行させる。世代番号を1つ進めることで、
    // 前のクレームで走っていたAI呼び出しが後から戻ってきても弾ける（fencing token）。
    const claimGeneration = (pending.claim_generation ?? 0) + 1;
    this.ctx.storage.sql.exec(
      "UPDATE pending_message_commands SET claimed_at = ?, claim_generation = ? WHERE command_id = ?",
      new Date().toISOString(),
      claimGeneration,
      command.commandId,
    );
    const snapshot = this.loadChatSnapshot(teamCode);
    return {
      kind: "pending",
      history: this.historyFor(snapshot, pending.thread_id),
      claimGeneration,
    };
  }

  /**
   * AI呼び出しの顛末を確定させる。`claimGeneration`はbeginChatMessageが返した
   * クレームの世代番号（fencing token）で、現在の世代と一致するときだけ適用する。
   *
   * クレームが古くなって別のリクエストが取り直した後に、前のAI呼び出しが遅れて
   * 戻ってくることがある。世代を見ないと、その古い応答が新しいクレームの結果を
   * 上書きしたり、解放したばかりのクレームをもう一度解放したりする。一致しない
   * ときは何も書かず`{ stale: true }`を返し、呼び出し側もsnapshotへ触れない。
   */
  async completeChatMessage(
    commandId: string,
    outcome: CompleteChatMessageOutcome,
    claimGenerationInput: unknown,
  ): Promise<ChatMessageResult | { retry: true } | { stale: true }> {
    const claimGeneration = claimGenerationSchema.parse(claimGenerationInput);
    const processed =
      this.ctx.storage.sql
        .exec<StoredMessageCommand>(
          "SELECT result, fingerprint FROM processed_message_commands WHERE command_id = ?",
          commandId,
        )
        .toArray()[0] ?? null;
    if (processed !== null)
      return chatMessageResultSchema.parse(JSON.parse(processed.result) as unknown);

    const pending =
      this.ctx.storage.sql
        .exec<StoredPendingMessage>(
          "SELECT thread_id, claimed_at, prompt_profile, fingerprint, claim_generation FROM pending_message_commands WHERE command_id = ?",
          commandId,
        )
        .toArray()[0] ?? null;
    if (pending === null) throw new Error("該当する送信途中のメッセージがありません。");
    if ((pending.claim_generation ?? 0) !== claimGeneration) return { stale: true };

    const text = assistantTextOf(outcome);
    if (text === null) {
      // クレームを解放する。解放しないと、正当な再送（同じcommandIdでの再送信）が
      // 誤って「進行中」と判定され、二度とAIを呼べなくなる。
      this.ctx.storage.sql.exec(
        "UPDATE pending_message_commands SET claimed_at = NULL WHERE command_id = ?",
        commandId,
      );
      return { retry: true };
    }
    return this.appendAssistantMessage(commandId, pending, text);
  }

  /**
   * 検証済みの応答をsnapshotへ積み、冪等台帳へ移す。completeChatMessageの複雑度を
   * 下げるための切り出し。
   */
  private appendAssistantMessage(
    commandId: string,
    pending: StoredPendingMessage,
    text: string,
  ): ChatMessageResult {
    const stored = this.ctx.storage.sql
      .exec<StoredChatState>("SELECT snapshot FROM chat_state WHERE id = 1")
      .toArray()[0];
    if (stored === undefined) throw new Error("チャット状態が見つかりません。");
    const snapshot = chatSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    // schemaを通してからappendする。ここで弾かれる値がsnapshotへ入ることはない。
    const assistantMessage: ChatMessage = chatMessageSchema.parse({
      messageId: crypto.randomUUID(),
      role: "assistant",
      text,
      createdAt: new Date().toISOString(),
    });
    const appended = appendMessage(snapshot, {
      threadId: pending.thread_id,
      message: assistantMessage,
    });
    if (!appended.ok) throw new Error("応答の保存先スレッドが見つかりません。");
    const result = chatMessageResultSchema.parse({
      snapshot: appended.snapshot,
      assistant: assistantMessage,
    });
    this.ctx.storage.transactionSync(() => {
      this.saveChatSnapshot(appended.snapshot);
      this.ctx.storage.sql.exec(
        // pending行の指紋をそのまま引き継ぐ。processed側にも残しておかないと、
        // 完了後の再送で内容の取り違えを検出できない。
        "INSERT INTO processed_message_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
        commandId,
        JSON.stringify(result),
        pending.fingerprint,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_message_commands WHERE command_id = ?",
        commandId,
      );
    });
    this.broadcastChat(appended.snapshot);
    return result;
  }

  private expirePendingMessages(): void {
    const cutoff = new Date(Date.now() - PENDING_MESSAGE_EXPIRY_MS).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM pending_message_commands WHERE created_at < ?", cutoff);
  }

  /** クレーム無し、またはクレームから十分な時間が経っていれば「取り直してよい」と判定する。 */
  private isClaimStale(claimedAt: string | null): boolean {
    if (claimedAt === null) return true;
    return Date.now() - new Date(claimedAt).getTime() > CLAIM_TIMEOUT_MS;
  }

  private historyFor(snapshot: ChatSnapshot, threadId: string): AiMessage[] {
    const thread = snapshot.threads.find((candidate) => candidate.threadId === threadId);
    return (thread?.messages ?? []).map((message) => ({ role: message.role, text: message.text }));
  }

  // ---- チェックポイント ----

  private readCheckpoint(): CheckpointSnapshot | null {
    const stored =
      this.ctx.storage.sql
        .exec<StoredCheckpointState>("SELECT snapshot FROM checkpoint_state WHERE id = 1")
        .toArray()[0] ?? null;
    return stored === null
      ? null
      : checkpointSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
  }

  async loadCheckpoint(teamCodeInput: unknown): Promise<CheckpointSnapshot | null> {
    teamCodeSchema.parse(teamCodeInput);
    return this.readCheckpoint();
  }

  /**
   * 台帳にあるcommandIdへの再送を、本文を見ずに処理する。適用済みのコマンドは二度と
   * 適用しない——台帳が指すrevisionが今のrevisionなら「直前の保存の再送」なので現在の
   * snapshotをそのまま返し、ずれていれば既に上書きされた古い保存なのでconflictにする
   * （クライアントはGETして最新を採用すればよい）。この判定により、台帳はsnapshotを
   * 持たず`(command_id, revision)`だけで足り、剪定して有限に保つ必要も無くなる——
   * 剪定すると、溢れた古いcommandIdの再送が「未処理」に見え、古いdataが最新revision
   * の新規保存として通ってしまう。
   */
  private replayCheckpoint(
    current: CheckpointSnapshot | null,
    appliedRevision: number,
  ): CheckpointSnapshot | CheckpointRejection {
    return current !== null && current.revision === appliedRevision
      ? current
      : { rejected: "conflict" };
  }

  /**
   * チェックポイントを保存する。`nowIso`はWorker側で採る——DOはテストからClockを
   * 差し替えられないため、時刻の境界をWorkerのhandlerへ寄せている。
   */
  async saveCheckpoint(
    teamCodeInput: unknown,
    commandInput: unknown,
    nowIsoInput: unknown,
    fingerprintInput: unknown,
  ): Promise<CheckpointSnapshot | CheckpointRejection> {
    const fingerprint = fingerprintSchema.parse(fingerprintInput);
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: SaveCheckpointCommand = saveCheckpointCommandSchema.parse(commandInput);
    const now = checkpointSnapshotSchema.shape.savedAt.parse(nowIsoInput);
    const saved =
      this.ctx.storage.sql
        .exec<StoredCheckpointCommand>(
          "SELECT revision, fingerprint FROM processed_checkpoint_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    const current = this.readCheckpoint();
    // 台帳の行も検証してから使う。壊れた行を「台帳に無い」と読み替えると、適用済みの
    // commandIdが未処理に見えて古いbodyを再適用してしまう。不整合は黙って通さず、
    // 例外にしてWorkerの503（時間を置いて再試行）へ倒す。
    if (saved !== null) {
      // 同じcommandIdで別のbodyを送る取り違えは冪等再送ではない。元の結果を返すと、
      // クライアントは保存したつもりの状態が入っていないことに気づけない。
      if (mismatchesFingerprint(saved.fingerprint, fingerprint)) return { rejected: "conflict" };
      return this.replayCheckpoint(
        current,
        checkpointSnapshotSchema.shape.revision.parse(saved.revision),
      );
    }

    const applied = applyCheckpoint(current, command, { teamCode, now });
    if (!applied.ok) return { rejected: applied.reason };
    try {
      this.writeCheckpoint(applied.snapshot, command, { current, fingerprint });
    } catch (caught) {
      if (caught instanceof CheckpointConflictError) return { rejected: "conflict" };
      throw caught;
    }
    return applied.snapshot;
  }

  /**
   * 状態更新と冪等台帳を1トランザクションで書く。片方だけ書けると、revisionだけ進んで
   * 台帳に記録が無い状態になり、同じcommandIdの再送が現在のsnapshotではなく新規の保存
   * として再適用されてしまう（AGENTS.mdの「保存失敗・重複イベント」）。CASが0行だった
   * 場合はreturnではロールバックできないので、例外で抜けてトランザクションごと巻き戻す。
   * saveCheckpointの複雑度を下げるための切り出し。
   */
  private writeCheckpoint(
    snapshot: CheckpointSnapshot,
    command: SaveCheckpointCommand,
    context: { current: CheckpointSnapshot | null; fingerprint: string },
  ): void {
    const { current, fingerprint } = context;
    // flushはCASを掛けずに確定させるので、照合はクライアントが申告したexpectedRevision
    // ではなく、直前に読んだ現在のrevision（合成の土台）で行う。通常の保存は従来どおり。
    const casRevision = command.flush === true ? current?.revision : command.expectedRevision;
    const serialized = JSON.stringify(snapshot);
    this.ctx.storage.transactionSync(() => {
      // 既存commandと同じくrevisionのCASで書く。想定外の並行更新があれば0行になる。
      const written =
        current === null
          ? this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO checkpoint_state (id, snapshot) VALUES (1, ?)",
              serialized,
            ).rowsWritten
          : this.ctx.storage.sql.exec(
              "UPDATE checkpoint_state SET snapshot = ? WHERE id = 1 AND json_extract(snapshot, '$.revision') = ?",
              serialized,
              casRevision ?? 0,
            ).rowsWritten;
      if (written === 0) throw new CheckpointConflictError();
      this.ctx.storage.sql.exec(
        "INSERT INTO processed_checkpoint_commands (command_id, revision, created_at, fingerprint) VALUES (?, ?, ?, ?)",
        command.commandId,
        snapshot.revision,
        snapshot.savedAt,
        fingerprint,
      );
    });
  }

  // ---- WebSocket ----

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketRequest(request)) return error("WebSocket接続が必要です。", 426);
    const parsed = teamCodeSchema.safeParse(new URL(request.url).searchParams.get("teamCode"));
    if (!parsed.success) return error("teamCodeはASCII数字6桁で指定してください。", 400);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ kind: "team", teamCode: parsed.data });
    this.ctx.acceptWebSocket(server);
    this.sendEnvelope(server, { kind: "team", snapshot: await this.join(parsed.data) });
    this.sendEnvelope(server, { kind: "chat", snapshot: this.loadChatSnapshot(parsed.data) });
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    void socket;
    void message;
  }
  override webSocketClose(socket: WebSocket): void {
    socket.close();
  }

  private async repairLeaderboard(
    result: CommandResult,
    commandId: string,
  ): Promise<CommandResult> {
    if (result.leaderboardPending) {
      try {
        await this.env.RACE_LEADERBOARD.getByName("global").upsert(
          result.snapshot.teamCode,
          result.snapshot,
        );
      } catch {
        return result;
      }
      const completed = commandResultSchema.parse({ ...result, leaderboardPending: false });
      this.ctx.storage.sql.exec(
        "UPDATE processed_commands SET result = ? WHERE command_id = ?",
        JSON.stringify(completed),
        commandId,
      );
      this.broadcast(completed.snapshot);
      return completed;
    }
    return result;
  }

  private broadcast(snapshot: TeamSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.sendEnvelope(socket, { kind: "team", snapshot });
    }
  }

  private broadcastChat(snapshot: ChatSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.sendEnvelope(socket, { kind: "chat", snapshot });
    }
  }

  private sendEnvelope(socket: WebSocket, message: TeamSyncMessage): void {
    try {
      socket.send(JSON.stringify(teamSyncMessageSchema.parse(message)));
    } catch {
      socket.close(1011, "配信に失敗しました。");
    }
  }
}
