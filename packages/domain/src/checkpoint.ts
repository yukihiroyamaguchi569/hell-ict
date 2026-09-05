import type {
  CheckpointBody,
  CheckpointRejectionReason,
  CheckpointSnapshot,
  CheckpointTrap,
  SaveCheckpointCommand,
} from "./schemas/checkpoint.js";
import type { TeamCode } from "./schemas/team-state.js";

export type CheckpointResult =
  | { ok: true; snapshot: CheckpointSnapshot }
  | { ok: false; reason: CheckpointRejectionReason };

/** 発動済み（true）の罠フラグをfalseへ戻そうとしているかを判定する。 */
const regressesTrap = (current: CheckpointTrap, next: CheckpointTrap): boolean =>
  (current.s3Used && !next.s3Used) || (current.s4Used && !next.s4Used);

/**
 * 保存済みのチェックポイントに対して後退している項目を返す。罠・経過時間・進行位置は
 * どれも「一度払った/進んだものを保存要求だけで取り消せない」ようにするための不変条件で、
 * 判定の優先順（trap→elapsed→pos）もここで固定する。いずれも同値は許可する
 * （同じ画面の再保存や再送では時計も位置も進んでいないため）。
 *
 * - trap: リロードで罠をリセットする抜け道を塞ぐ（企画書§6「連続罰は1回まで」）。
 * - elapsedMs: 罰は時間で払う設計なので、小さい値を送って払った時間を取り消させない。
 * - pos: 最新revisionを取り直した古いタブが古いposで保存すると、復帰先が前のステージへ戻る。
 *
 * viewはposに従属する表示なので、view単体の後退は見ない——同じposの中で画面を
 * 行き来する導線（マニュアル閲覧など）を塞がないため。
 */
const detectRegression = (
  current: CheckpointBody,
  next: CheckpointBody,
): CheckpointRejectionReason | null => {
  if (regressesTrap(current.trap, next.trap)) return "trap-regression";
  if (next.elapsedMs < current.elapsedMs) return "elapsed-regression";
  if (next.pos < current.pos) return "pos-regression";
  if (next.dataRevision < current.dataRevision) return "data-regression";
  return null;
};

/**
 * 現在の状態と受信bodyを単調に合成する。
 *
 * 離脱時のkeepalive送信（flush）は応答を待てない——`sendBeacon`/`keepalive: true`は
 * 投げっぱなしで、409が返っても再送する主体がもうページに居ない。revisionのCASで
 * 弾くと、その送信に載っていた罠フラグや進行位置が黙って消える。送信中の通常保存が
 * 先に確定して revision が進んでいるのは正常な競合であり、内容の衝突ではない。
 *
 * 合成の向きは既存の後退拒否（detectRegression）と同じ——罠はOR、posとelapsedMsはmax。
 * どの項目も単調にしか動かないので、合成結果に対して後退検査を掛ける必要はない。
 * viewは「その位置に居た側」を採る。posが同値なら受信側を新しいとみなす
 * （同じ停留所の中では後から届いた画面のほうが後の状態）。dataも土台は同じ側を採るが、
 * 罰の進行状態だけは両側の進んだほうを残す（理由はmergePenalties）。
 */
/**
 * view・dataをどちらから採るかを決める。まずposの大きい側、posが同じならdataRevision
 * の大きい側、どちらも同じなら受信側を新しいとみなす。
 *
 * posだけで決めると、同じ停留所の中で古いタブのflushが新しいdataを巻き戻せる
 * （罰の進行状態がin-progressからnoneへ戻る、など）。dataRevisionはクライアントが
 * dataを書き換えるたび単調に増やす世代番号で、同一pos内の前後関係をこれで決める。
 */
const newerSide = (current: CheckpointBody, incoming: CheckpointBody): CheckpointBody => {
  if (incoming.pos !== current.pos) return incoming.pos > current.pos ? incoming : current;
  return incoming.dataRevision >= current.dataRevision ? incoming : current;
};

/**
 * サーバーが中身を解釈する唯一の`data`キー。ここだけが「dataは不透明」の例外である。
 * 罰は時間で払う設計（企画書§6）なので、罰の進行状態が巻き戻せると払わずに済ませられる
 * ——posの大きい側のdataを丸ごと採ると、罠を踏まずに先へ進んだ古いタブ（dataRevisionが
 * 低い）の離脱時flushが、もう一方のタブでin-progress/doneになっていた罰をnoneへ戻せる。
 * 2キーだけをここで単調に合成し、それ以外のステージ状態は従来どおり不透明に扱う。
 */
const PENALTY_KEYS = ["s3Penalty", "s4Penalty"] as const;

/** 罰の進行順。左ほど手前で、合成では常に右（進んだ側）が勝つ。 */
const PENALTY_ORDER = ["none", "in-progress", "done"] as const;

type PenaltyState = (typeof PENALTY_ORDER)[number];

const isPenaltyState = (value: unknown): value is PenaltyState =>
  typeof value === "string" && PENALTY_ORDER.some((state) => state === value);

/** 未定義・未知の値は最小（none相当）として扱う。古いクライアントや細工を巻き戻しに使わせない。 */
const penaltyRank = (value: unknown): number =>
  isPenaltyState(value) ? PENALTY_ORDER.indexOf(value) : 0;

/** 両側の進んだほうの罰の状態。どちらも既知の値でなければundefined（結果に書かない）。 */
const strongerPenalty = (a: unknown, b: unknown): PenaltyState | undefined => {
  const winner = penaltyRank(a) >= penaltyRank(b) ? a : b;
  return isPenaltyState(winner) ? winner : undefined;
};

/** `source`のdataを土台に、罰の2キーだけ両側の進んだ値へ差し替える。 */
const mergePenalties = (
  current: CheckpointBody,
  incoming: CheckpointBody,
  source: CheckpointBody,
): CheckpointBody["data"] => {
  const data: CheckpointBody["data"] = { ...source.data };
  for (const key of PENALTY_KEYS) {
    const penalty = strongerPenalty(current.data[key], incoming.data[key]);
    if (penalty !== undefined) data[key] = penalty;
  }
  return data;
};

export const mergeCheckpoint = (
  current: CheckpointBody,
  incoming: CheckpointBody,
): CheckpointBody => {
  const source = newerSide(current, incoming);
  return {
    view: source.view,
    data: mergePenalties(current, incoming, source),
    pos: Math.max(current.pos, incoming.pos),
    elapsedMs: Math.max(current.elapsedMs, incoming.elapsedMs),
    dataRevision: Math.max(current.dataRevision, incoming.dataRevision),
    trap: {
      s3Used: current.trap.s3Used || incoming.trap.s3Used,
      s4Used: current.trap.s4Used || incoming.trap.s4Used,
    },
  };
};

/**
 * チェックポイントの保存可否を決める純粋関数。`current`がnullなら未保存であり、
 * その場合のexpectedRevisionは0だけを許す（初回保存の結果はrevision 1になる）。
 * 競合は後退より先に判定する——revisionが合っていない保存は中身を見るまでもなく
 * 取り直しが要るため。
 */
export const applyCheckpoint = (
  current: CheckpointSnapshot | null,
  command: SaveCheckpointCommand,
  context: { teamCode: TeamCode; now: string },
): CheckpointResult => {
  const revision = current?.revision ?? 0;
  const committed = (body: CheckpointBody): CheckpointResult => ({
    ok: true,
    snapshot: { teamCode: context.teamCode, revision: revision + 1, savedAt: context.now, body },
  });
  // flush（離脱時のkeepalive）はCASを掛けず単調マージで確定させる。合成が単調なので
  // 後退検査も要らない（理由はmergeCheckpoint）。
  if (command.flush === true) {
    return committed(current === null ? command.body : mergeCheckpoint(current.body, command.body));
  }
  if (command.expectedRevision !== revision) return { ok: false, reason: "conflict" };
  const regression = current === null ? null : detectRegression(current.body, command.body);
  if (regression !== null) return { ok: false, reason: regression };
  return committed(command.body);
};
