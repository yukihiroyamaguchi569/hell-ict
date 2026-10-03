import { redactPii } from "@hell-ict/domain";
import type {
  GameEvent,
  GameInstant,
  GameStageId,
  TeamGameCommand,
  TeamGameCommandType,
  TrapStageId,
} from "@hell-ict/domain";
import { z } from "zod";

import { VIEW_OF_STAGE } from "./progress.js";

/**
 * ゲームのコマンド（Issue #234）を適用した結果を、活動ログ（D1のactivity_events）の行へ
 * 写す（Issue #235）。副作用の無い変換だけを持ち、保存はGameStore（DOの送信待ち）と
 * activity-log.tsのrecordGameActivity（D1）が受け持つ。
 *
 * モックが送る自己申告のログ（`submit.*`・`verdict.*`・`trap.*`）と混ざらないよう、kindは
 * 別の名前（`game.*`・`penalty.*`）にし、metaには必ず`source: "server"`を入れる。既存の
 * kindは1つも変えない——分析手順（hell-ict-scenario:docs/testplay/ログ分析手順.md）の集計はkindで絞るので、
 * そのまま動く。
 *
 * 1つのコマンドから出る行は、kindがすべて異なる。D1のUNIQUE（開催回・チーム・commandId・
 * kind）とINSERT OR IGNOREで、同じコマンドの送り直しが行を増やさないのはこのためである。
 */

/** metaの値。クライアントのmetaと同じく平坦にし、入れ子はJSON文字列にして入れる。 */
const metaValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const gameActivityRowSchema = z
  .object({
    kind: z.string(),
    commandId: z.string(),
    view: z.string(),
    text: z.string(),
    meta: z.record(z.string(), metaValueSchema),
    /** サーバがコマンドを適用した時刻。D1へ積むのが遅れても、起きた時刻はこちらで分かる。 */
    at: z.string(),
  })
  .strict();

export type GameActivityRow = z.infer<typeof gameActivityRowSchema>;

type Meta = GameActivityRow["meta"];

/** 本文の上限。クライアントの活動ログ（ACTIVITY_TEXT_MAX）と揃える。 */
const TEXT_MAX_CHARS = 20000;

/** 提出として残す本文とmeta。本文を残さないステージ（S5）は空文字にする。 */
interface Submission {
  text: string;
  meta: Meta;
}

/** コマンドがどのステージのものか。`advance`は出発したステージで数える。 */
const STAGE_OF_COMMAND = {
  "inbox.open": "prologue",
  "inbox.reply": "prologue",
  "inbox.settle": "prologue",
  "s1.start": "s1",
  "s1.reply": "s1",
  "s1.memo-reply": "s1",
  "s1.settle": "s1",
  "s1.next-round": "s1",
  "s2.start": "s2",
  "s2.take-addendum": "s2",
  "s2.submit": "s2",
  "s3.submit": "s3",
  "s3.finish-penalty": "s3",
  "s4.submit-summary": "s4",
  "s4.submit-action": "s4",
  "s5.check-ai-message": "s5",
  "s5.submit": "s5",
  "s5.submit-report": "s5",
  "s6.generate": "s6",
  "s6.submit": "s6",
} as const satisfies Record<Exclude<TeamGameCommandType, "advance">, GameStageId>;

const commandStage = (command: TeamGameCommand): GameStageId =>
  command.type === "advance" ? command.from : STAGE_OF_COMMAND[command.type];

type CommandOf<T extends TeamGameCommandType> = Extract<TeamGameCommand, { type: T }>;

type SubmissionReaders = {
  [T in TeamGameCommandType]?: (command: CommandOf<T>) => Submission;
};

/**
 * 提出にあたるコマンドと、その本文の残し方。モックの自己申告ログに合わせる:
 * 返信・要約・指示は本文を残し、S2は表をTSVで、S3は3欄をJSONで残す。S5は罠の対象
 * （個人情報の載った一覧）そのものなので本文を残さず、文字数と伏せた箇所の数だけを残す。
 */
const SUBMISSION_READERS: SubmissionReaders = {
  "inbox.reply": (c) => ({ text: c.text, meta: { mailId: c.mailId } }),
  "s1.reply": (c) => ({ text: c.text, meta: { mailId: c.mailId } }),
  "s1.memo-reply": (c) => ({ text: c.text, meta: { mailId: "memo" } }),
  "s2.submit": (c) => ({
    text: c.grid.map((row) => row.join("\t")).join("\n"),
    meta: { rows: c.grid.length },
  }),
  "s3.submit": (c) => ({ text: JSON.stringify(c.submission), meta: {} }),
  "s4.submit-summary": (c) => ({ text: c.text, meta: { which: "summary" } }),
  "s4.submit-action": (c) => ({ text: c.text, meta: { which: "action" } }),
  "s5.submit": (c) => ({
    text: "",
    meta: { form: "linelist", chars: c.text.length },
  }),
  "s5.submit-report": (c) => ({
    text: "",
    meta: { form: "report", masked: new Set(c.maskedIndices).size },
  }),
  "s6.generate": (c) => ({ text: c.prompt, meta: {} }),
  "s6.submit": (c) => ({ text: "", meta: { candidateIndex: c.candidateIndex } }),
};

/** コマンドとその読み手を型で対応させる（team-game.tsのdispatchと同じ理由）。 */
const readSubmission = <T extends TeamGameCommandType>(
  command: CommandOf<T> & { type: T },
): Submission | null => {
  const reader: SubmissionReaders[T] = SUBMISSION_READERS[command.type];
  return reader === undefined ? null : reader(command);
};

/**
 * 判定の詳細（識別子と数だけで、提出本文は入らない）をmetaへ平坦に写す。値が入れ子なら
 * JSON文字列にする——SQLiteのjson_extractで読み出せる。判定が無ければnull。
 */
const judgementMeta = (judgement: unknown): Meta | null => {
  if (judgement === null || typeof judgement !== "object" || Array.isArray(judgement)) return null;
  const meta: Meta = {};
  for (const [key, value] of Object.entries(judgement)) {
    const parsed = metaValueSchema.safeParse(value);
    meta[key] = parsed.success ? parsed.data : JSON.stringify(value);
  }
  return meta;
};

/** 罰の始まった時刻。罰が終わった行に、かかった時間を添えるために使う。 */
export type PenaltyStarts = Partial<Record<TrapStageId, GameInstant>>;

/** 適用・拒否のどちらか。再送（duplicate）は行を出さないので受け取らない。 */
export type GameActivityOutcome =
  | { status: "applied"; events: readonly GameEvent[]; judgement: unknown }
  | { status: "rejected"; reason: string; judgement: unknown };

export interface GameActivityInput {
  command: TeamGameCommand;
  outcome: GameActivityOutcome;
  /** コマンドを適用（または拒否）した時刻。 */
  at: GameInstant;
  penaltyStarts: PenaltyStarts;
}

const penaltyDuration = (stage: TrapStageId, at: GameInstant, starts: PenaltyStarts): Meta => {
  const startedAt = starts[stage];
  if (startedAt === undefined) return { startedAt: null, durationMs: null };
  return { startedAt, durationMs: Date.parse(at) - Date.parse(startedAt) };
};

/** 状態機械のeventから出す行。差し戻し（submission-rejected）は判定の行に含まれる。 */
const eventRows = (
  event: GameEvent,
  penaltyStarts: PenaltyStarts,
): { kind: string; meta: Meta }[] => {
  switch (event.type) {
    case "stage-cleared":
      return [{ kind: "game.clear", meta: {} }];
    case "stage-entered":
      return [{ kind: "game.enter", meta: {} }];
    // 最初の罠は必ず罰を始める（D1）。罠と罰の始まりを別の行にして、どちらも数えられるようにする。
    case "trap-triggered":
      return [
        { kind: "game.trap", meta: { repeated: false } },
        { kind: "penalty.start", meta: {} },
      ];
    case "trap-repeated":
      return [{ kind: "game.trap", meta: { repeated: true } }];
    case "penalty-completed":
      return [
        { kind: "penalty.complete", meta: penaltyDuration(event.stage, event.at, penaltyStarts) },
      ];
    case "submission-rejected":
      return [];
  }
};

interface RowSpec {
  kind: string;
  stage: GameStageId;
  meta: Meta;
  at: string;
  text?: string;
}

/** コマンドごとに同じ列（commandId・source・command）を閉じ込めた行の作り手。 */
const rowMaker =
  (command: TeamGameCommand) =>
  (spec: RowSpec): GameActivityRow => ({
    kind: spec.kind,
    commandId: command.commandId,
    view: VIEW_OF_STAGE[spec.stage],
    // 個人情報は伏せ字にしてから残す（保存直前のゲートは、伏せ字の無い本文を丸ごと捨てる）。
    text: redactPii(spec.text ?? "").slice(0, TEXT_MAX_CHARS),
    meta: { source: "server", command: command.type, stage: spec.stage, ...spec.meta },
    at: spec.at,
  });

/**
 * 拒否は、提出か、判定の付いた拒否（締めの早すぎなど）だけを1行で残す。判定の無い
 * ボタンの押し直しの拒否は数が多く、分析に要らない。S6の丸写しはここで
 * reason: "copied-from-mail" として残る。提出の本文もこの行に入れる——拒否された
 * コマンドは同じcommandIdで送り直せるので、別に`game.submit`を書くと、後で通った
 * 送り直しの`game.submit`がUNIQUEで捨てられる。
 */
const rejectedRows = (
  input: GameActivityInput,
  reason: string,
  judged: Meta | null,
): GameActivityRow[] => {
  const submission = readSubmission(input.command);
  if (submission === null && judged === null) return [];
  const meta = { ...submission?.meta, ...judged, reason };
  const stage = commandStage(input.command);
  const text = submission?.text;
  return [rowMaker(input.command)({ kind: "game.rejected", stage, at: input.at, meta, text })];
};

const appliedRows = (
  input: GameActivityInput,
  events: readonly GameEvent[],
  judged: Meta | null,
): GameActivityRow[] => {
  const { command, at } = input;
  const row = rowMaker(command);
  const stage = commandStage(command);
  const submission = readSubmission(command);
  const rows: GameActivityRow[] = [];
  if (submission !== null) rows.push(row({ kind: "game.submit", stage, at, ...submission }));
  if (judged !== null) rows.push(row({ kind: "game.verdict", stage, at, meta: judged }));
  for (const event of events) {
    for (const entry of eventRows(event, input.penaltyStarts)) {
      rows.push(row({ ...entry, stage: event.stage, at: event.at }));
    }
  }
  return rows;
};

/** 1つのコマンドの結果から、活動ログへ積む行を作る。 */
export const gameActivityRows = (input: GameActivityInput): GameActivityRow[] => {
  const { outcome } = input;
  const judged = judgementMeta(outcome.judgement);
  return outcome.status === "rejected"
    ? rejectedRows(input, outcome.reason, judged)
    : appliedRows(input, outcome.events, judged);
};
