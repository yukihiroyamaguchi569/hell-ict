import {
  chatSnapshotSchema,
  chatThreadIdSchema,
  countThreadsOfKind,
  createThread as domainCreateThread,
  createThreadResultSchema,
  initialChatSnapshot,
  redactSnapshotPii,
  stageAiView,
  stageThreadTitle,
} from "@hell-ict/domain";
import type {
  AiMessage,
  ChatSnapshot,
  ChatThreadKind,
  CreateThreadCommand,
  GameStageId,
  StageAi,
  TeamCode,
  TeamGameState,
} from "@hell-ict/domain";

import { mismatchesFingerprint } from "./guard.js";
import { readProcessedThread } from "./chat-ledger.js";
import { migrateLedgerPii } from "./ledger-pii-migration.js";
import type { ConflictReply, CreateThreadOutcome, ThreadLimitReply } from "./team-room-types.js";

/**
 * TeamRoom's chat snapshot (chat_state) and thread creation. Input parsing and the
 * reset-generation check stay in TeamRoom (the RPC surface). Everything here is synchronous
 * so TeamRoom can call it in the same synchronous section as its other writes, and inside
 * transactionSync.
 */

export type StoredChatState = { snapshot: string };

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

/** What ChatStore needs from the DO: its storage, and the chat broadcast to open sockets. */
export type ChatStoreContext = {
  readonly storage: DurableObjectStorage;
  readonly broadcastChat: (snapshot: ChatSnapshot) => void;
};

export class ChatStore {
  constructor(private readonly context: ChatStoreContext) {}

  /**
   * チャットのsnapshotを読む。伏せ字化を入れる前に保存された平文のPIIが、GET・
   * WebSocket配信・台帳の再生から出続けないよう、読み出した時点で伏せ字へ置き換える。
   * 内容が変わったらその場で保存し直す（一度きりの移行。次回以降は参照が変わらないので
   * 書き込みは走らない）。
   */
  loadChatSnapshot(teamCode: TeamCode): ChatSnapshot {
    migrateLedgerPii(this.context.storage);
    const stored =
      this.context.storage.sql
        .exec<StoredChatState>("SELECT snapshot FROM chat_state WHERE id = 1")
        .toArray()[0] ?? null;
    if (stored !== null) {
      const parsed = chatSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
      const redacted = redactSnapshotPii(parsed);
      if (redacted !== parsed) this.saveChatSnapshot(redacted);
      return redacted;
    }
    const snapshot = initialChatSnapshot(teamCode, crypto.randomUUID());
    this.context.storage.sql.exec(
      "INSERT INTO chat_state (id, snapshot) VALUES (1, ?)",
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  saveChatSnapshot(snapshot: ChatSnapshot): void {
    this.context.storage.sql.exec(
      "UPDATE chat_state SET snapshot = ? WHERE id = 1",
      JSON.stringify(snapshot),
    );
  }

  historyFor(snapshot: ChatSnapshot, threadId: string): AiMessage[] {
    const thread = snapshot.threads.find((candidate) => candidate.threadId === threadId);
    return (thread?.messages ?? []).map((message) => ({ role: message.role, text: message.text }));
  }

  /**
   * ステージの会話をサーバで用意する（モックの`activateStageThread`。クライアントはもう
   * スレッドを作らない、Issue #236）。同名のステージスレッドがあれば何もしない——
   * 前進の再送、再試行、モックが先に作っていた場合のどれでも1本に保つ。
   *
   * 失敗は握る。前進そのものは成立させ、会話が無いことはGETの`ai.status: "failed"`で
   * 画面へ伝える——前のステージの会話を黙って出し続けない（Issue #85）。
   */
  ensureStageThread(teamCode: TeamCode, stage: GameStageId): void {
    const title = stageThreadTitle(stage);
    if (title === null) return;
    try {
      const snapshot = this.loadChatSnapshot(teamCode);
      if (stageAiView(stage, snapshot).status === "ready") return;
      if (countThreadsOfKind(snapshot, "stage") >= MAX_STAGE_THREADS_PER_TEAM) return;
      const created = domainCreateThread(snapshot, {
        threadId: chatThreadIdSchema.parse(crypto.randomUUID()),
        title,
        kind: "stage",
      });
      if (!created.ok) return;
      this.saveChatSnapshot(created.snapshot);
      this.context.broadcastChat(created.snapshot);
    } catch {
      // 会話のsnapshotが読めない・書けない。ai.status が "failed" のまま残る。
    }
  }

  /** 今のステージのAI。会話のsnapshotが読めなければ、会話は用意できていないものとして示す。 */
  stageAi(teamCode: TeamCode, state: TeamGameState): StageAi {
    try {
      return stageAiView(state.game.stage, this.loadChatSnapshot(teamCode));
    } catch {
      return { status: "failed" };
    }
  }

  /** Creates a thread for a command whose generation the caller has already checked. */
  createThread(
    teamCode: TeamCode,
    command: CreateThreadCommand,
    fingerprint: string,
  ): CreateThreadOutcome | ThreadLimitReply | ConflictReply {
    const saved = readProcessedThread(this.context.storage.sql, command.commandId);
    if (saved !== null) {
      // 同じcommandIdで別のタイトル・別のkindを送る取り違えは冪等再送ではない。
      if (mismatchesFingerprint(saved.fingerprint, fingerprint)) return { conflict: true };
      return { snapshot: saved.result.snapshot, created: false };
    }
    const snapshot = this.loadChatSnapshot(teamCode);
    // ステージ用スレッドはtitleがステージ名で一意、という契約にする。リロードや
    // タブの競合で同じステージの作成要求が二重に来ても増やさない——commandIdは
    // 要求ごとに新しいので、冪等台帳だけでは同名スレッドの増殖を止められない。
    // manualは参加者が同じ名前を付けてよいので従来どおり増やす。
    if (command.kind === "stage") {
      const existing = snapshot.threads.find(
        (thread) => (thread.kind ?? "manual") === "stage" && thread.title === command.title,
      );
      if (existing !== undefined) return this.replayExistingThread(snapshot, command, fingerprint);
    }
    // 冪等再送（processed済み）は上限に関係なく従来の結果を返す。上限を当てるのは
    // 新しいスレッドを実際に増やすときだけである。kindごとに独立して数える。
    const max = THREAD_LIMITS[command.kind];
    if (countThreadsOfKind(snapshot, command.kind) >= max) {
      return { threadLimit: true, max, kind: command.kind };
    }
    const threadId = chatThreadIdSchema.parse(crypto.randomUUID());
    const created = domainCreateThread(snapshot, {
      threadId,
      title: command.title,
      kind: command.kind,
    });
    if (!created.ok) throw new Error("スレッドの作成に失敗しました。");
    const result = createThreadResultSchema.parse({ snapshot: created.snapshot });
    // snapshotの更新と冪等台帳は必ず同時に成立させる。片方だけ書けると、スレッドは
    // 増えたのに台帳に記録が無い状態になり、同じcommandIdの再送が新規作成として
    // もう1本増やしてしまう（checkpointと同じ流儀）。
    this.context.storage.transactionSync(() => {
      this.saveChatSnapshot(created.snapshot);
      this.context.storage.sql.exec(
        "INSERT INTO processed_thread_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
        command.commandId,
        JSON.stringify(result),
        fingerprint,
      );
    });
    this.context.broadcastChat(created.snapshot);
    return { snapshot: result.snapshot, created: true, threadId };
  }

  /**
   * 既に同じステージ用スレッドがある作成要求へ、現在のsnapshotをそのまま返す。
   * 台帳へも記録して、同じcommandIdの再送が同じ結果を返すようにする。
   */
  private replayExistingThread(
    snapshot: ChatSnapshot,
    command: CreateThreadCommand,
    fingerprint: string,
  ): CreateThreadOutcome {
    const result = createThreadResultSchema.parse({ snapshot });
    this.context.storage.sql.exec(
      "INSERT OR IGNORE INTO processed_thread_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
      command.commandId,
      JSON.stringify(result),
      fingerprint,
    );
    return { snapshot: result.snapshot, created: false };
  }
}
