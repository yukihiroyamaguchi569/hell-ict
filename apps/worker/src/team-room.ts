import {
  appendMessage,
  chatMessageResultSchema,
  chatSnapshotSchema,
  commandResultSchema,
  createThread as domainCreateThread,
  createThreadCommandSchema,
  createThreadResultSchema,
  initialChatSnapshot,
  initialTeamSnapshot,
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
  CommandResult,
  CreateThreadCommand,
  CreateThreadResult,
  SendMessageCommand,
  TeamCode,
  TeamSnapshot,
  TeamSyncMessage,
} from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";

import { RATE_LIMIT_WINDOW_MS, rateLimitBucket, rateLimitRetryAfterSeconds } from "./guard.js";
import { error, isWebSocketRequest } from "./http.js";

type StoredCommand = { result: string };
type StoredState = { snapshot: string };
type StoredChatState = { snapshot: string };
type StoredThreadCommand = { result: string };
type StoredMessageCommand = { result: string };
type StoredPendingMessage = { thread_id: string; claimed_at: string | null };
type StoredRateLimit = { count: number };
type ConflictReply = { conflict: true };
type UnknownThreadReply = { unknownThread: true };

export type BeginChatMessageOutcome =
  | { kind: "already-processed"; result: ChatMessageResult }
  | { kind: "pending"; history: AiMessage[] }
  | { kind: "in-progress" }
  | { kind: "rate-limited"; retryAfterSeconds: number };

export type CompleteChatMessageOutcome = { kind: "success"; text: string } | { kind: "failure" };

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
      "CREATE TABLE IF NOT EXISTS processed_thread_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_message_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending_message_commands (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, claimed_at TEXT)",
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

  async createThread(teamCodeInput: unknown, commandInput: unknown): Promise<CreateThreadResult> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: CreateThreadCommand = createThreadCommandSchema.parse(commandInput);
    const saved =
      this.ctx.storage.sql
        .exec<StoredThreadCommand>(
          "SELECT result FROM processed_thread_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (saved !== null) return createThreadResultSchema.parse(JSON.parse(saved.result) as unknown);
    const snapshot = this.loadChatSnapshot(teamCode);
    const created = domainCreateThread(snapshot, {
      threadId: crypto.randomUUID(),
      title: command.title,
    });
    if (!created.ok) throw new Error("スレッドの作成に失敗しました。");
    this.saveChatSnapshot(created.snapshot);
    const result = createThreadResultSchema.parse({ snapshot: created.snapshot });
    this.ctx.storage.sql.exec(
      "INSERT INTO processed_thread_commands (command_id, result) VALUES (?, ?)",
      command.commandId,
      JSON.stringify(result),
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
  private consumeRateLimit(nowMs: number, limit: number): number | null {
    const bucket = rateLimitBucket(nowMs, RATE_LIMIT_WINDOW_MS);
    // 固定窓なので過去の窓の行は不要。1行だけ残す。
    this.ctx.storage.sql.exec("DELETE FROM rate_limit WHERE bucket <> ?", bucket);
    const stored =
      this.ctx.storage.sql
        .exec<StoredRateLimit>("SELECT count FROM rate_limit WHERE bucket = ?", bucket)
        .toArray()[0] ?? null;
    if ((stored?.count ?? 0) >= limit) {
      return rateLimitRetryAfterSeconds(nowMs, RATE_LIMIT_WINDOW_MS);
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO rate_limit (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1",
      bucket,
    );
    return null;
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
    nowMs: number,
    limit: number,
  ): Promise<BeginChatMessageOutcome | UnknownThreadReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: SendMessageCommand = sendMessageCommandSchema.parse(commandInput);
    this.expirePendingMessages();
    const processed =
      this.ctx.storage.sql
        .exec<StoredMessageCommand>(
          "SELECT result FROM processed_message_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (processed !== null)
      return {
        kind: "already-processed",
        result: chatMessageResultSchema.parse(JSON.parse(processed.result) as unknown),
      };

    const pending =
      this.ctx.storage.sql
        .exec<StoredPendingMessage>(
          "SELECT thread_id, claimed_at FROM pending_message_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (pending !== null) return this.resumePending(teamCode, command.commandId, pending);

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
    // ここまでは何も永続化していない。枠を消費するのはこの直後の保存とpending行作成の
    // ためだけであり、超過なら何も書かずに戻る。
    const retryAfterSeconds = this.consumeRateLimit(nowMs, limit);
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    this.saveChatSnapshot(appended.snapshot);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at) VALUES (?, ?, ?, ?)",
      command.commandId,
      command.threadId,
      now,
      now,
    );
    this.broadcastChat(appended.snapshot);
    return { kind: "pending", history: this.historyFor(appended.snapshot, command.threadId) };
  }

  /**
   * 既にpending行が残っているcommandIdの再送を捌く。クレームが生きていれば処理中、
   * 古ければ取り直して履歴を返す。どちらも新しい送信ではないので枠は消費しない。
   * beginChatMessageの複雑度を下げるための切り出し。
   */
  private resumePending(
    teamCode: TeamCode,
    commandId: string,
    pending: StoredPendingMessage,
  ): BeginChatMessageOutcome {
    if (!this.isClaimStale(pending.claimed_at)) return { kind: "in-progress" };
    // 未クレーム、またはクレームが古い（AI呼び出しが完了しないまま終わった）ので、
    // ここで改めてクレームを取り直してから再試行させる。
    this.ctx.storage.sql.exec(
      "UPDATE pending_message_commands SET claimed_at = ? WHERE command_id = ?",
      new Date().toISOString(),
      commandId,
    );
    const snapshot = this.loadChatSnapshot(teamCode);
    return { kind: "pending", history: this.historyFor(snapshot, pending.thread_id) };
  }

  async completeChatMessage(
    commandId: string,
    outcome: CompleteChatMessageOutcome,
  ): Promise<ChatMessageResult | { retry: true }> {
    const processed =
      this.ctx.storage.sql
        .exec<StoredMessageCommand>(
          "SELECT result FROM processed_message_commands WHERE command_id = ?",
          commandId,
        )
        .toArray()[0] ?? null;
    if (processed !== null)
      return chatMessageResultSchema.parse(JSON.parse(processed.result) as unknown);

    const pending =
      this.ctx.storage.sql
        .exec<StoredPendingMessage>(
          "SELECT thread_id, claimed_at FROM pending_message_commands WHERE command_id = ?",
          commandId,
        )
        .toArray()[0] ?? null;
    if (pending === null) throw new Error("該当する送信途中のメッセージがありません。");
    if (outcome.kind === "failure") {
      // クレームを解放する。解放しないと、正当な再送（同じcommandIdでの再送信）が
      // 誤って「進行中」と判定され、二度とAIを呼べなくなる。
      this.ctx.storage.sql.exec(
        "UPDATE pending_message_commands SET claimed_at = NULL WHERE command_id = ?",
        commandId,
      );
      return { retry: true };
    }

    const stored = this.ctx.storage.sql
      .exec<StoredChatState>("SELECT snapshot FROM chat_state WHERE id = 1")
      .toArray()[0];
    if (stored === undefined) throw new Error("チャット状態が見つかりません。");
    const snapshot = chatSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    const assistantMessage: ChatMessage = {
      messageId: crypto.randomUUID(),
      role: "assistant",
      text: outcome.text,
      createdAt: new Date().toISOString(),
    };
    const appended = appendMessage(snapshot, {
      threadId: pending.thread_id,
      message: assistantMessage,
    });
    if (!appended.ok) throw new Error("応答の保存先スレッドが見つかりません。");
    this.saveChatSnapshot(appended.snapshot);
    const result = chatMessageResultSchema.parse({
      snapshot: appended.snapshot,
      assistant: assistantMessage,
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO processed_message_commands (command_id, result) VALUES (?, ?)",
      commandId,
      JSON.stringify(result),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_message_commands WHERE command_id = ?",
      commandId,
    );
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
