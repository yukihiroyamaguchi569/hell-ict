import {
  applyTeamGameCommand,
  gameEventSchema,
  gameInstantSchema,
  initialTeamGameState,
  resetGenerationSchema,
  stageAiSchema,
  teamGameJudgementSchema,
  teamGameRejectionReasonSchema,
  teamGameLatestMs,
  teamGameStanding,
  teamGameStateSchema,
} from "@hell-ict/domain";
import type { GameEvent, TeamGameCommand, TeamGameStanding, TeamGameState } from "@hell-ict/domain";
import { z } from "zod";

import { gameActivityRows, gameActivityRowSchema } from "./game-activity.js";
import type { GameActivityOutcome, GameActivityRow, PenaltyStarts } from "./game-activity.js";
import { fingerprintSchema } from "./guard.js";

/**
 * TeamRoomのゲーム状態（Issue #234）の保存。DOのSQLiteに対する読み書きだけを持ち、
 * 判定と遷移はdomainのapplyTeamGameCommand（純粋関数）に任せる。
 *
 * - game_state: チームのゲーム状態1行（D1のGameStateとステージ固有の状態）。
 * - processed_game_commands: 適用したコマンドの冪等台帳。結果（判定の詳細とevents）を
 *   残し、同じcommandIdの再送には状態を動かさずにそれを返す。拒否したコマンドは残さない
 *   ——D1と同じく、条件が整えば同じコマンドを送り直せる。提出本文は残さない（指紋だけ）。
 * - game_standing_outbox: 帯（RaceLeaderboard）へまだ送れていない位置の印（1行）。停留所が
 *   動いた遷移と同じトランザクションで立て、帯への反映が済んだら消す。反映が失敗しても
 *   印が残るので、次のコマンドかGETで送り直せる。
 * - game_progress_outbox: 進捗（D1のprogress_events）へまだ積めていない遷移のevents。
 *   帯と同じく遷移と同時に積み、D1へ書けたら消す。D1が落ちても遷移は失われない。
 * - game_activity_outbox: 活動ログ（D1のactivity_events）へまだ積めていない行（Issue #235）。
 *   提出・判定・罠・罰・クリアを、進捗と同じくコマンドの適用と同時に積み、D1へ書けたら消す。
 *   本文はgame-activity.tsで伏せ字にしてから積む（S5は本文を持たない）。
 *
 * 3つの送信待ちの表は、行に積んだときのリセット世代を持ち、読むのも消すのもその世代の行に
 * 限る。送信の途中でGMリセットが入り、新しい世代の遷移が積まれても、遅れて終わった古い
 * 送信がそれを消したり、古い世代で送ったりしない（リセットで行番号とseqは振り直される）。
 */
export const GAME_TABLES_DDL = [
  "CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS processed_game_commands (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS game_standing_outbox (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, seq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS game_progress_outbox (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, events TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS game_activity_outbox (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, rows TEXT NOT NULL)",
] as const;

/** game_progress_outboxの行。壊れていたら例外にして、送らずに残す（黙って捨てない）。 */
const storedProgressRowSchema = z.object({ id: z.number().int(), events: z.string() });

/**
 * 活動ログを1回のbatchで送る送信待ちの行数。1行は1コマンド分で、D1の行は多くて数行になる
 * （提出・判定・罠・罰の開始など）。D1のbatchの上限に十分な余裕を残す。
 */
export const ACTIVITY_OUTBOX_CHUNK = 20;

/** game_activity_outboxの行。進捗と同じく、壊れていたら送らずに残す。 */
const storedActivityRowSchema = z.object({ id: z.number().int(), rows: z.string() });

/** 停留所か到達時刻が動くevent（クリアと前進）。 */
const movesStanding = (events: readonly GameEvent[]): boolean =>
  events.some((event) => event.type === "stage-cleared" || event.type === "stage-entered");

/**
 * 帯へ送る順位の基準。順番の印（seq）はD1が適用したコマンドの数で、遷移のたびに増える
 * （停留所を動かすのはすべてD1のコマンドなので、位置が変わればseqも必ず増える）。
 */
export const standingOf = (state: TeamGameState): { standing: TeamGameStanding; seq: number } => ({
  standing: teamGameStanding(state),
  seq: state.game.processedCommandIds.length,
});

/** 台帳に残す結果。適用したコマンドだけを残すので、いつも適用の形である。 */
const storedOutcomeSchema = z
  .object({ events: z.array(gameEventSchema), judgement: teamGameJudgementSchema })
  .strict();

type StoredOutcome = z.infer<typeof storedOutcomeSchema>;

const parseOutcome = (raw: string): StoredOutcome =>
  storedOutcomeSchema.parse(JSON.parse(raw) as unknown);

/**
 * SQLiteは列の型を強制しないので、読み出しも検証する。壊れていたら例外にして、Workerの
 * 503（時間を置いて再試行）へ倒す——初期状態へ読み替えると、進んでいたチームがPrologueへ
 * 戻ってしまう。台帳の行を「無い」と読み替えると、適用済みのコマンドをもう一度適用する。
 */
const storedStateRowSchema = z.object({ state: z.string() });

const storedLedgerRowSchema = z.object({ fingerprint: fingerprintSchema, outcome: z.string() });

/** 1コマンドの結果。適用・拒否・再送のどれでも、その時点の状態を添える。 */
const gameCommandReplySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("applied"),
      state: teamGameStateSchema,
      events: z.array(gameEventSchema),
      judgement: teamGameJudgementSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      state: teamGameStateSchema,
      reason: teamGameRejectionReasonSchema,
      judgement: teamGameJudgementSchema,
    })
    .strict(),
  // 同じcommandIdの再送。最初に適用したときの結果（判定とevents）を添える。
  z
    .object({
      kind: z.literal("duplicate"),
      state: teamGameStateSchema,
      original: storedOutcomeSchema,
    })
    .strict(),
]);

export type GameCommandReply = z.infer<typeof gameCommandReplySchema>;

/** 同じcommandIdが別の内容で使われた。冪等再送ではないので何も返さない。 */
export type GameCommandConflict = { conflict: true };

/**
 * TeamRoom.applyGameCommandの戻り値。RPCの境界なので、Worker側でもう一度検証してから使う
 * （ブランド型とJSONを含む状態は、RPCの型の写しが深すぎて呼び出し側で推論できない）。
 */
export const gameCommandRpcResultSchema = z.union([
  z.object({ staleGeneration: z.literal(true) }).strict(),
  z.object({ conflict: z.literal(true) }).strict(),
  // `ai`は適用後のステージのAI（会話のスレッド、Issue #236）。
  z
    .object({ reply: gameCommandReplySchema, generation: resetGenerationSchema, ai: stageAiSchema })
    .strict(),
]);

export type GameCommandRpcResult = z.infer<typeof gameCommandRpcResultSchema>;

/** TeamRoom.gameState・prepareStageThreadの戻り値。状態と、今のステージのAIを同じ読みから返す。 */
export const gameViewRpcResultSchema = z
  .object({ state: teamGameStateSchema, ai: stageAiSchema })
  .strict();

export type GameViewRpcResult = z.infer<typeof gameViewRpcResultSchema>;

/** 判定の詳細はJSONとして残す。読み戻したときの形はteamGameJudgementSchemaで確かめる。 */
const toJson = (judgement: unknown): z.infer<typeof teamGameJudgementSchema> =>
  teamGameJudgementSchema.parse(JSON.parse(JSON.stringify(judgement ?? null)) as unknown);

const instantOf = (nowMs: number) => gameInstantSchema.parse(new Date(nowMs).toISOString());

export class GameStore {
  /** `generation`はこのリクエストが照合したリセット世代。送信待ちの行はこの世代で扱う。 */
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly generation: number,
  ) {}

  /** 状態を読む。まだ無ければ`nowMs`に始まった初期状態を作って保存する。 */
  load(nowMs: number): TeamGameState {
    const stored = this.read();
    if (stored !== null) return stored;
    const state = initialTeamGameState(instantOf(nowMs));
    this.storage.sql.exec(
      "INSERT INTO game_state (id, state) VALUES (1, ?)",
      JSON.stringify(state),
    );
    return state;
  }

  /** 保存済みの状態。まだ無ければnull。 */
  read(): TeamGameState | null {
    const raw = this.storage.sql.exec("SELECT state FROM game_state WHERE id = 1").toArray()[0];
    if (raw === undefined) return null;
    const row = storedStateRowSchema.parse(raw);
    return teamGameStateSchema.parse(JSON.parse(row.state) as unknown);
  }

  /**
   * 1コマンドを台帳・判定・保存まで通す。DOは同期区間を直列に実行するので、読みから書きまで
   * awaitを挟まないこの関数の中では、同じチームの別のコマンドが割り込むことはない
   * ——2つのタブが同時に送っても、片方ずつ順に、もう片方の結果を見て判定される。
   */
  apply(
    command: TeamGameCommand,
    nowMs: number,
    fingerprint: string,
  ): GameCommandReply | GameCommandConflict {
    const saved = this.readLedger(command.commandId);
    if (saved !== null) {
      if (saved.fingerprint !== fingerprint) return { conflict: true };
      return { kind: "duplicate", state: this.load(nowMs), original: saved.outcome };
    }
    const state = this.load(nowMs);
    // 時計はWorkerが読んでから届くので、並行したコマンドでは後に適用するほうの時刻が
    // 先に適用したものより早いことがある。記録済みの時刻より前には戻さず、クリア・前進・
    // ゴールの時刻を適用の順に並べる（順位はこの時刻で決まる）。
    const appliedMs = Math.max(nowMs, teamGameLatestMs(state));
    const result = applyTeamGameCommand(state, command, {
      ms: appliedMs,
      at: instantOf(appliedMs),
    });
    if (result.status === "rejected") {
      const judgement = toJson(result.judgement);
      this.queueActivity(command, { status: "rejected", reason: result.reason, judgement }, nowMs);
      return { kind: "rejected", state, reason: result.reason, judgement };
    }
    const next = teamGameStateSchema.parse(result.state);
    const outcome: StoredOutcome = { events: result.events, judgement: toJson(result.judgement) };
    // 罰の始まりは台帳から引く。書き込みの前に読むので、トランザクションの外でよい。
    const penaltyStarts = this.penaltyStarts(outcome.events);
    // 状態と台帳は必ず同時に成立させる。片方だけ書けると、進んだのに台帳に無いコマンドの
    // 再送がもう一度適用される（チェックポイントと同じ流儀）。
    this.storage.transactionSync(() => {
      this.storage.sql.exec("UPDATE game_state SET state = ? WHERE id = 1", JSON.stringify(next));
      this.storage.sql.exec(
        "INSERT INTO processed_game_commands (command_id, fingerprint, outcome) VALUES (?, ?, ?)",
        command.commandId,
        fingerprint,
        JSON.stringify(outcome),
      );
      // 停留所や到達時刻が動いたら、帯と進捗へ送る分も同じトランザクションで積む。
      if (movesStanding(outcome.events)) {
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO game_standing_outbox (id, generation, seq) VALUES (1, ?, ?)",
          this.generation,
          standingOf(next).seq,
        );
        this.storage.sql.exec(
          "INSERT INTO game_progress_outbox (generation, events) VALUES (?, ?)",
          this.generation,
          JSON.stringify(outcome.events),
        );
      }
      // 活動ログの行も同じトランザクションで積む。適用されたのに記録が無い、を作らない。
      this.queueActivity(command, { status: "applied", ...outcome }, appliedMs, penaltyStarts);
    });
    return { kind: "applied", state: next, ...outcome };
  }

  /** 進捗（D1）へまだ送れていない遷移。`lastId`までを送り終えたら`clearProgress`で消す。 */
  pendingProgress(): { lastId: number; events: GameEvent[] } | null {
    const rows = this.storage.sql
      .exec(
        "SELECT id, events FROM game_progress_outbox WHERE generation = ? ORDER BY id",
        this.generation,
      )
      .toArray()
      .map((row) => storedProgressRowSchema.parse(row));
    const last = rows.at(-1);
    if (last === undefined) return null;
    const events = rows.flatMap((row) =>
      z.array(gameEventSchema).parse(JSON.parse(row.events) as unknown),
    );
    return { lastId: last.id, events };
  }

  clearProgress(lastId: number): void {
    this.storage.sql.exec(
      "DELETE FROM game_progress_outbox WHERE generation = ? AND id <= ?",
      this.generation,
      lastId,
    );
  }

  /** 活動ログ（D1）へまだ送れていない行。`lastId`までを送り終えたら`clearActivity`で消す。 */
  pendingActivity(): { lastId: number; rows: GameActivityRow[] } | null {
    // D1が長く落ちて溜まっても1回のbatchが上限を超えないよう、古い順に区切って読む。
    const stored = this.storage.sql
      .exec(
        "SELECT id, rows FROM game_activity_outbox WHERE generation = ? ORDER BY id LIMIT ?",
        this.generation,
        ACTIVITY_OUTBOX_CHUNK,
      )
      .toArray()
      .map((row) => storedActivityRowSchema.parse(row));
    const last = stored.at(-1);
    if (last === undefined) return null;
    const rows = stored.flatMap((row) =>
      z.array(gameActivityRowSchema).parse(JSON.parse(row.rows) as unknown),
    );
    return { lastId: last.id, rows };
  }

  clearActivity(lastId: number): void {
    this.storage.sql.exec(
      "DELETE FROM game_activity_outbox WHERE generation = ? AND id <= ?",
      this.generation,
      lastId,
    );
  }

  /** 帯へまだ送れていない位置があるか。 */
  hasPendingStanding(): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM game_standing_outbox WHERE generation = ?", this.generation)
        .toArray().length > 0
    );
  }

  /**
   * 帯への反映が済んだ。`seq`までの遷移を送ったので、その後に動いていれば（印のseqが
   * より大きければ）印は残し、次の機会に新しい位置を送る。
   */
  clearPendingStanding(seq: number): void {
    this.storage.sql.exec(
      "DELETE FROM game_standing_outbox WHERE generation = ? AND seq <= ?",
      this.generation,
      seq,
    );
  }

  /** コマンドの結果を活動ログの行にして、送信待ちへ積む。行が無ければ何もしない。 */
  private queueActivity(
    command: TeamGameCommand,
    outcome: GameActivityOutcome,
    atMs: number,
    penaltyStarts: PenaltyStarts = {},
  ): void {
    const rows = gameActivityRows({ command, outcome, at: instantOf(atMs), penaltyStarts });
    if (rows.length === 0) return;
    this.storage.sql.exec(
      "INSERT INTO game_activity_outbox (generation, rows) VALUES (?, ?)",
      this.generation,
      JSON.stringify(rows),
    );
  }

  /**
   * 今回終わる罰の始まった時刻（Issue #216: 罰にかかった時間）。状態は罰の始まりを持たない
   * ので、台帳に残る最初の罠（trap-triggered）の時刻を引く。罰が終わらないコマンドでは読まない。
   * 台帳はGMリセットで空になるので、リセット前の罠を拾うことはない。
   */
  private penaltyStarts(events: readonly GameEvent[]): PenaltyStarts {
    if (!events.some((event) => event.type === "penalty-completed")) return {};
    const starts: PenaltyStarts = {};
    const outcomes = this.storage.sql
      .exec("SELECT fingerprint, outcome FROM processed_game_commands ORDER BY rowid")
      .toArray()
      .map((raw) => parseOutcome(storedLedgerRowSchema.parse(raw).outcome));
    for (const outcome of outcomes) {
      for (const event of outcome.events) {
        if (event.type === "trap-triggered") starts[event.stage] ??= event.at;
      }
    }
    return starts;
  }

  private readLedger(commandId: string): { fingerprint: string; outcome: StoredOutcome } | null {
    const raw = this.storage.sql
      .exec(
        "SELECT fingerprint, outcome FROM processed_game_commands WHERE command_id = ?",
        commandId,
      )
      .toArray()[0];
    if (raw === undefined) return null;
    const row = storedLedgerRowSchema.parse(raw);
    return { fingerprint: row.fingerprint, outcome: parseOutcome(row.outcome) };
  }
}
