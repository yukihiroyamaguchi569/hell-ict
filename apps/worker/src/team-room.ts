import {
  commandIdSchema,
  checkpointSnapshotSchema,
  commandResultSchema,
  createThreadCommandSchema,
  initialTeamSnapshot,
  resetGenerationSchema,
  saveCheckpointCommandSchema,
  detectPii,
  resolveStageChatTarget,
  sendMessageCommandSchema,
  stageAiPlan,
  stageChatCommandSchema,
  stageChatText,
  teamCodeSchema,
  teamCommandSchema,
  teamGameCommandSchema,
  teamSnapshotSchema,
  teamSyncMessageSchema,
  transitionTeam,
} from "@hell-ict/domain";
import type {
  ChatMessageResult,
  ChatSnapshot,
  CheckpointSnapshot,
  CommandResult,
  CommandStatus,
  CreateThreadCommand,
  SaveCheckpointCommand,
  SendMessageCommand,
  StageChatCommand,
  TeamCode,
  TeamSnapshot,
  TeamGameState,
  TeamSyncMessage,
} from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  beginChatGateSchema,
  chatClaimTokenSchema,
  completeChatOutcomeSchema,
  fingerprintSchema,
  nowMsSchema,
  rateLimitCountSchema,
} from "./guard.js";
import { CHAT_COMMAND_IDS_MAX, error, isWebSocketRequest } from "./http.js";
import { GameStore } from "./game-store.js";
import { GamePublisher } from "./game-publish.js";
import { CheckpointStore } from "./checkpoint-store.js";
import type { CheckpointRejection } from "./checkpoint-store.js";
import { ensureTeamRoomTables, RESET_TABLES } from "./team-room-schema.js";
import { consumeRateLimit } from "./rate-limit-store.js";
import {
  expirePendingMessages,
  messageCommandStatus,
  readPending,
  readProcessedMessage,
  replayProcessed,
} from "./chat-ledger.js";
import type { StoredPendingMessage } from "./chat-ledger.js";
import { ChatStore } from "./chat-store.js";
import { ChatMessages } from "./chat-messages.js";
import type { RateLimitVerdict } from "./rate-limit-store.js";
import type { GameCommandRpcResult, GameViewRpcResult } from "./game-store.js";
import type {
  BeginChatMessageGate,
  BeginChatMessageOutcome,
  BeginStageChatOutcome,
  CompleteChatMessageOutcome,
  ConflictReply,
  CreateThreadOutcome,
  StageChatRoute,
  StaleGenerationReply,
  ThreadLimitReply,
  UnknownThreadReply,
} from "./team-room-types.js";

type StoredCommand = { result: string };
type StoredState = { snapshot: string };

/**
 * chatSnapshotへ渡せる問い合わせ対象のID。RPCの境界なので、Worker側で検証済みでも
 * ここでもう一度形と件数を見る（上限はhttp.tsのCHAT_COMMAND_IDS_MAXと揃える）。
 */
const chatCommandIdsSchema = z.array(commandIdSchema).max(CHAT_COMMAND_IDS_MAX);

/**
 * リセット世代の行。SQLiteは列の型を強制しないので読み出しも検証する。壊れていたら
 * 例外にする——0へ倒すと、リセット済みのチームで古い端末の書き込みが復活しうる。
 */
const storedGenerationSchema = z.object({ value: z.number().int().nonnegative() });

export class TeamRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureTeamRoomTables(this.ctx.storage.sql);
  }

  // ---- チーム状態（P1Bから継続） ----

  /**
   * チーム状態をまるごと初期化する（ゲームマスター用。`POST /api/gm/teams/.../reset`）。
   * テーブルは残して行だけ消すので、次の入室でjoinが初期snapshotを作り直し、
   * 冪等台帳が空でもチャット送信・チェックポイント保存はそのまま通る。
   *
   * WebSocketのattachment（`serializeAttachment`）はソケットごとの値でSQLには無く、
   * 次の接続で作り直される。開いたままの接続は古い画面を持ち続けるので、リセット後は
   * 参加者にリロードさせる運用にする（docs/development-harness.md）。
   *
   * 削除は1つのトランザクションにまとめる。途中で落ちて「会話だけ消えて
   * チェックポイントが残る」という中途半端な状態を作らない。
   */
  async resetTeam(teamCodeInput: unknown): Promise<{ readonly ok: true }> {
    teamCodeSchema.parse(teamCodeInput);
    this.ctx.storage.transactionSync(() => {
      for (const table of RESET_TABLES) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
      // 世代を進めるのも同じトランザクションで。行を消したのに世代が据え置かれると、
      // リロードしていない端末の保存が「初回保存」として通り、状態が戻ってしまう。
      this.ctx.storage.sql.exec("UPDATE reset_generation SET value = value + 1 WHERE id = 1");
    });
    return { ok: true };
  }

  /**
   * 現在のリセット世代。入室（POST /api/session）の応答へ載せてクライアントへ渡す。
   */
  async resetGeneration(teamCodeInput: unknown): Promise<number> {
    teamCodeSchema.parse(teamCodeInput);
    return this.readGeneration();
  }

  /**
   * 進捗記録（POST /api/progress）が、この端末の世代で書いてよいかを問う。
   * チェックポイントと違いD1直書きなので、DOへ照合だけを尋ねる形にする。
   */
  async matchesResetGeneration(teamCodeInput: unknown, generationInput: unknown): Promise<boolean> {
    teamCodeSchema.parse(teamCodeInput);
    return resetGenerationSchema.parse(generationInput) === this.readGeneration();
  }

  private readGeneration(): number {
    const row =
      this.ctx.storage.sql.exec("SELECT value FROM reset_generation WHERE id = 1").toArray()[0] ??
      null;
    // 行が無いのはこのDOの初期化前だけで、その状態では世代0が正しい。
    return row === null ? 0 : storedGenerationSchema.parse(row).value;
  }

  /**
   * 入室。snapshotと世代を1回のRPCで返す——別々に呼ぶと、その2回の間にリセットが
   * 入ったときに「リセット前のsnapshotとリセット後の世代」という、どちらとも
   * 食い違う組をクライアントへ渡してしまう。DOは操作を直列に実行するので、
   * 同じ同期区間で両方を読めばその隙間は生まれない。
   */
  async join(teamCodeInput: unknown): Promise<{ snapshot: TeamSnapshot; generation: number }> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    return { snapshot: this.joinSnapshot(teamCode), generation: this.readGeneration() };
  }

  /**
   * チーム状態を読み、無ければ初期状態を作る。DO内から呼ぶ同期版で、世代は返さない
   * ——`command()`とWebSocket配信が必要とするのはsnapshotだけである。
   */
  private joinSnapshot(teamCode: TeamCode): TeamSnapshot {
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
  ): Promise<CommandResult | ConflictReply | StaleGenerationReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command = teamCommandSchema.parse(commandInput);
    // 世代の照合は冪等台帳より前。台帳を先に引くと、リセット前のcommandIdが
    // 「処理済み」として古いsnapshotを返しうる。
    if (command.generation !== this.readGeneration()) return { staleGeneration: true };
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
    const transition = transitionTeam(this.joinSnapshot(teamCode), command);
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

  // ---- ゲーム状態（Issue #234） ----

  /**
   * チームのゲーム状態を返す（`GET /api/teams/:code/game`）。まだ無ければ`nowMs`に始まる
   * 初期状態を作る。`nowMs`はWorkerの時計で採る——DOはテストから時計を差し替えられない。
   * 帯への反映が残っていれば、ここでも送り直す。今のステージのAI（会話のスレッド、Issue #236）
   * も同じ読みから添える——状態とAIを別々のRPCで読むと、その間の前進で食い違う。
   */
  async gameState(teamCodeInput: unknown, nowMsInput: unknown): Promise<GameViewRpcResult> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const nowMs = nowMsSchema.parse(nowMsInput);
    const store = new GameStore(this.ctx.storage, this.readGeneration());
    store.load(nowMs);
    await this.gamePublisher.publish(teamCode, store);
    // 送信を待つ間に別のコマンドが適用されうるので、返す状態は待った後に読み直す
    // ——先に読んだ状態を返すと、再接続した画面を1手前へ巻き戻してしまう。
    const state = store.load(nowMs);
    return { state, ai: this.chatStore.stageAi(teamCode, state) };
  }

  /**
   * 今のステージの会話の準備をやり直す（`POST /api/teams/:code/game/chat/thread`、Issue #85）。
   * 前進のときの作成が失敗していた場合に、画面の［再試行］から呼ぶ。作成は同名のステージ
   * スレッドがあれば何もしないので、何度呼ばれても1本しか増えない。
   */
  async prepareStageThread(
    teamCodeInput: unknown,
    generationInput: unknown,
    nowMsInput: unknown,
  ): Promise<GameViewRpcResult | StaleGenerationReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const nowMs = nowMsSchema.parse(nowMsInput);
    const generation = this.readGeneration();
    // 古いタブが、リセット後のチームに前の世代のステージの会話を作らないようにする。
    if (resetGenerationSchema.parse(generationInput) !== generation)
      return { staleGeneration: true };
    const state = new GameStore(this.ctx.storage, generation).load(nowMs);
    this.chatStore.ensureStageThread(teamCode, state.game.stage);
    return { state, ai: this.chatStore.stageAi(teamCode, state) };
  }

  /**
   * 画面のコマンドを1つ適用する（`POST /api/teams/:code/game/commands`）。世代の照合は
   * 台帳より前（ほかの書き込みと同じ理由）。`fingerprint`はWorkerで計算して渡す——DOの中で
   * awaitすると、その隙に同じcommandIdの別リクエストが入り込む。
   *
   * 戻り値の形は`gameCommandRpcResultSchema`。型は`unknown`として公開し、Workerがschemaで
   * 検証してから使う——状態とJSONの判定を含む型は、RPCの型の写しが深すぎて呼び出し側で
   * 推論できない（TS2589）。中身は下の`result`で型検査している。
   */
  async applyGameCommand(
    teamCodeInput: unknown,
    commandInput: unknown,
    nowMsInput: unknown,
    fingerprintInput: unknown,
  ): Promise<unknown> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command = teamGameCommandSchema.parse(commandInput);
    const nowMs = nowMsSchema.parse(nowMsInput);
    const fingerprint = fingerprintSchema.parse(fingerprintInput);
    const generation = this.readGeneration();
    if (command.generation !== generation) return { staleGeneration: true };
    const store = new GameStore(this.ctx.storage, generation);
    const reply = store.apply(command, nowMs, fingerprint);
    if ("conflict" in reply) return reply satisfies GameCommandRpcResult;
    // ステージに入ったら、そのステージの会話をサーバで用意する（Issue #236）。前進の直後、
    // awaitを挟まずに作るので、入場と会話の用意の間に別のタブの送信が割り込まない。
    if (reply.kind === "applied" && reply.events.some((event) => event.type === "stage-entered"))
      this.chatStore.ensureStageThread(teamCode, reply.state.game.stage);
    const ai = this.chatStore.stageAi(teamCode, reply.state);
    await this.gamePublisher.publish(teamCode, store);
    const result: GameCommandRpcResult = { reply, generation, ai };
    return result;
  }

  /**
   * Publishes game transitions (standing, progress, activity log). One instance per DO: its send
   * queues are what keep the sends one-at-a-time, so it must not be created per call.
   */
  private readonly gamePublisher = new GamePublisher(this.env);

  // ---- チャット ----

  /** The chat snapshot and thread creation. It holds no per-call state, so one per DO. */
  private readonly chatStore = new ChatStore({
    storage: this.ctx.storage,
    broadcastChat: (snapshot) => this.broadcastChat(snapshot),
  });

  /** Accepting and completing chat messages. It holds no per-call state, so one per DO. */
  private readonly chatMessages = new ChatMessages({
    storage: this.ctx.storage,
    chatStore: this.chatStore,
    readGeneration: () => this.readGeneration(),
    broadcastChat: (snapshot) => this.broadcastChat(snapshot),
  });

  /**
   * チャットのsnapshotを返す。`commandIdsInput`を渡した呼び出しでは、そのIDが
   * 冪等台帳のどこにあるかも添える。再入室したクライアントは、これで「手元の
   * 未確定IDのうち、もう完了しているのはどれか」をID単位で確かめられる——
   * 履歴の本文や並び順からは区別できない（同じ文面を打ち直したとき、そして
   * 先に送った要求が後から完了したときに取り違える）。
   */
  async chatSnapshot(teamCodeInput: unknown, commandIdsInput?: unknown): Promise<ChatSnapshot> {
    const snapshot = this.chatStore.loadChatSnapshot(teamCodeSchema.parse(teamCodeInput));
    if (commandIdsInput === undefined) return snapshot;
    const commandIds = chatCommandIdsSchema.parse(commandIdsInput);
    const commands: Record<string, CommandStatus> = {};
    for (const commandId of commandIds)
      commands[commandId] = messageCommandStatus(this.ctx.storage.sql, commandId);
    return { ...snapshot, commands };
  }

  async createThread(
    teamCodeInput: unknown,
    commandInput: unknown,
    fingerprintInput: unknown,
  ): Promise<CreateThreadOutcome | ThreadLimitReply | ConflictReply | StaleGenerationReply> {
    const fingerprint = fingerprintSchema.parse(fingerprintInput);
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: CreateThreadCommand = createThreadCommandSchema.parse(commandInput);
    // 世代の照合は冪等台帳より前（command()と同じ理由）。
    if (command.generation !== this.readGeneration()) return { staleGeneration: true };
    return this.chatStore.createThread(teamCode, command, fingerprint);
  }

  /**
   * 送信前PIIゲートで拒否する送信のために、レート制限の枠を1つだけ消費する。
   *
   * PII拒否はbeginChatMessageへ進まないため通常の枠消費を通らず、PII入りの本文を
   * 連投するだけで活動ログ（activity_events）を無限に増やせてしまう。beginChatMessageと
   * 同じテーブル・同じ窓を使い、二重計上にならないよう「PII拒否経路はこれだけ、
   * 通常経路はbeginChatMessageだけ」が枠を消費する分担にする。
   */
  async consumeChatAttempt(
    nowMs: unknown,
    limit: unknown,
    generationInput: unknown,
  ): Promise<RateLimitVerdict | StaleGenerationReply> {
    // 世代の照合は枠を減らす前。ここを通すと、リセット前のタブがPII入りの本文を
    // 連投するだけで、入り直したチームの送信枠と活動ログを削れてしまう。
    if (resetGenerationSchema.parse(generationInput) !== this.readGeneration())
      return { staleGeneration: true };
    const retryAfterSeconds = consumeRateLimit(
      this.ctx.storage.sql,
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
  async consumeActivityAttempt(
    nowMs: unknown,
    limit: unknown,
    generationInput: unknown,
  ): Promise<RateLimitVerdict | StaleGenerationReply> {
    // 枠を減らす前に世代を見る。リセット前のタブが記録を積み続けると、入り直した
    // チームの活動ログの枠を食い潰す（D1の行も増える）。
    if (resetGenerationSchema.parse(generationInput) !== this.readGeneration())
      return { staleGeneration: true };
    const retryAfterSeconds = consumeRateLimit(
      this.ctx.storage.sql,
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
  ): Promise<BeginChatMessageOutcome | UnknownThreadReply | StaleGenerationReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command: SendMessageCommand = sendMessageCommandSchema.parse(commandInput);
    const validated = beginChatGateSchema.parse(gate);
    // 世代の照合は台帳の参照とレート制限の消費より前。古いタブの送信で枠を減らさない。
    if (command.generation !== this.readGeneration()) return { staleGeneration: true };
    return this.chatMessages.begin(teamCode, command, validated);
  }

  // ---- ステージに結び付いたAIチャット（Issue #236） ----

  /**
   * ステージの経路の送信を受け付ける（`POST /api/teams/:code/game/chat/messages`）。送り先の
   * 会話とシステムプロンプトは、画面ではなくゲーム状態のステージで決める。
   *
   * 再送（processed・pending）は、ステージが変わった後でも最初に受け付けた送り先のまま
   * 扱う——冪等性をステージの判定より先に置く。新しい送信は、次の順で止める:
   * AIの無いステージ → 下書きの条件 → 送信前PIIゲート（Stage 5なら罠）→ 会話が無い。
   * PIIゲートを「会話が無い」より先に置くのは、会話の用意に失敗していても、個人情報を
   * 送ろうとした事実（罠）は確定させるため。
   */
  async beginStageChatMessage(
    teamCodeInput: unknown,
    commandInput: unknown,
    gateInput: unknown,
  ): Promise<BeginStageChatOutcome> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command = stageChatCommandSchema.parse(commandInput);
    const gate = beginChatGateSchema.parse(gateInput);
    if (command.generation !== this.readGeneration()) return { staleGeneration: true };
    expirePendingMessages(this.ctx.storage.sql);
    const processed = readProcessedMessage(this.ctx.storage.sql, command.commandId);
    if (processed !== null) return replayProcessed(processed, gate.fingerprint);
    const pending = readPending(this.ctx.storage.sql, command.commandId);
    if (pending !== null) return this.resumeStageChat(teamCode, command, pending, gate);
    return this.beginNewStageChat(teamCode, command, gate);
  }

  /**
   * ステージの経路の再送。pending行はこの経路では必ず指紋を持つので、指紋が一致しない
   * （指紋の無い古い行を含む）ものは取り違えとして突き返す。
   */
  private resumeStageChat(
    teamCode: TeamCode,
    command: StageChatCommand,
    pending: StoredPendingMessage,
    gate: BeginChatMessageGate,
  ): BeginStageChatOutcome {
    if (pending.fingerprint !== gate.fingerprint) return { kind: "conflict" };
    const outcome = this.chatMessages.resumePending(teamCode, command.commandId, pending, gate);
    if (outcome.kind !== "pending") return outcome;
    const route: StageChatRoute = {
      threadId: pending.thread_id,
      promptProfile: pending.prompt_profile ?? "default",
      text: command.type === "stage-message" ? command.text : null,
    };
    return { ...outcome, route };
  }

  private beginNewStageChat(
    teamCode: TeamCode,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
  ): BeginStageChatOutcome {
    const state = new GameStore(this.ctx.storage, this.readGeneration()).load(gate.nowMs);
    const stage = state.game.stage;
    if (stageAiPlan(stage)?.live?.command !== command.type) return { refused: "no-ai-chat" };
    const text = stageChatText(state, command, gate.nowMs);
    if (!text.ok) return { draftRejected: text.reason };
    // 送信前PIIゲート（企画書§7）。ユーザー発言を保存させず、OpenAIへも一切送らない。
    // 会話のsnapshotはこの後で読む——読めない（壊れている）ときでも罠は確定させる。
    if (detectPii(text.text) !== null)
      return this.blockStageChatPii(state, command, gate, text.text);
    const target = resolveStageChatTarget(
      stage,
      this.chatStore.loadChatSnapshot(teamCode),
      command.type,
    );
    if (!target.ok) return { refused: target.reason };
    return this.appendStageChatMessage(teamCode, command, gate, {
      threadId: target.threadId,
      promptProfile: target.promptProfile,
      text: text.text,
    });
  }

  /** サーバが決めた送り先へ、旧経路と同じ受付（枠・ユーザー発言・pending行）で積む。 */
  private appendStageChatMessage(
    teamCode: TeamCode,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
    route: StageChatRoute & { text: string },
  ): BeginStageChatOutcome {
    const outcome = this.chatMessages.appendPendingMessage(
      teamCode,
      {
        type: "send-message",
        commandId: command.commandId,
        threadId: route.threadId,
        text: route.text,
        promptProfile: route.promptProfile,
        generation: command.generation,
      },
      gate,
    );
    if (!("kind" in outcome) || outcome.kind !== "pending") return outcome;
    return { ...outcome, route };
  }

  /**
   * 送信前PIIゲートで止めた送信。旧経路と同じく枠を1つ消費する（連投で活動ログを増やせない
   * ように）。Stage 5では、同じ操作で罠（罰の開始）をゲーム状態へ確定させる——画面の申告を
   * 待たないので、OpenAIへ何も送らないことと罰の開始が同じサーバの判断で揃う。罠はSV1の
   * `s5.check-ai-message`と同じ判定・同じ台帳を通るので、同じcommandIdの再送で二度踏まない。
   * 罠は枠の判定より先に確定させる——枠を使い切った後に個人情報を送ろうとしても、罰は始まる。
   */
  private blockStageChatPii(
    state: TeamGameState,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
    text: string,
  ): BeginStageChatOutcome {
    if (state.game.stage === "s5") {
      const store = new GameStore(this.ctx.storage, this.readGeneration());
      const trap = store.apply(
        {
          type: "s5.check-ai-message",
          commandId: command.commandId,
          generation: command.generation,
          text,
        },
        gate.nowMs,
        gate.fingerprint,
      );
      if ("conflict" in trap) return { kind: "conflict" };
    }
    const retryAfterSeconds = consumeRateLimit(
      this.ctx.storage.sql,
      "chat",
      gate.nowMs,
      gate.limit,
    );
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    const promptProfile = stageAiPlan(state.game.stage)?.live?.profile ?? null;
    return { piiBlocked: { promptProfile, length: text.length } };
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
    commandIdInput: unknown,
    outcomeInput: unknown,
    tokenInput: unknown,
  ): Promise<ChatMessageResult | { retry: true } | { stale: true }> {
    // 他のRPCと同じく、補助入力も実行時に検証する。壊れた値で台帳やクレームを
    // 触らせない（弾いた入力は例外になり、Worker側のcatchが503へ倒す）。
    const commandId = commandIdSchema.parse(commandIdInput);
    const outcome: CompleteChatMessageOutcome = completeChatOutcomeSchema.parse(outcomeInput);
    const token = chatClaimTokenSchema.parse(tokenInput);
    // リセットを挟んだ応答は、クレームの世代が偶然一致しても書かない。何も書かずに
    // 捨てる——古いタブの再送はbeginChatMessageが世代切れで弾くので、そちらへ回る。
    if (token.resetGeneration !== this.readGeneration()) return { stale: true };
    return this.chatMessages.complete(commandId, outcome, token);
  }
  // ---- チェックポイント ----

  async loadCheckpoint(teamCodeInput: unknown): Promise<CheckpointSnapshot | null> {
    teamCodeSchema.parse(teamCodeInput);
    return new CheckpointStore(this.ctx.storage).read();
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
    // 世代の照合はいちばん先に置く。冪等台帳の参照よりも前に弾かないと、リセット前の
    // commandIdが「処理済み」として現在のsnapshotを返してしまう（台帳は消えているので
    // 実際には通らないが、判定の順序として世代を最優先に固定しておく）。
    // flushも同じ扱いにする——CASを外す経路だからこそ、持ち主の確認は外せない。
    if (command.generation !== this.readGeneration()) return { rejected: "stale-generation" };
    return new CheckpointStore(this.ctx.storage).save(command, { teamCode, now, fingerprint });
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
    this.sendEnvelope(server, { kind: "team", snapshot: this.joinSnapshot(parsed.data) });
    this.sendEnvelope(server, {
      kind: "chat",
      snapshot: this.chatStore.loadChatSnapshot(parsed.data),
    });
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
          this.readGeneration(),
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
