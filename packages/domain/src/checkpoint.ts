import type {
  CheckpointBody,
  CheckpointSnapshot,
  CheckpointTrap,
  SaveCheckpointCommand,
} from "./schemas/checkpoint.js";
import type { TeamCode } from "./schemas/team-state.js";

export type CheckpointRejectionReason =
  | "conflict"
  | "trap-regression"
  | "elapsed-regression"
  | "pos-regression";

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
  return null;
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
  if (command.expectedRevision !== revision) return { ok: false, reason: "conflict" };
  const regression = current === null ? null : detectRegression(current.body, command.body);
  if (regression !== null) return { ok: false, reason: regression };
  return {
    ok: true,
    snapshot: {
      teamCode: context.teamCode,
      revision: revision + 1,
      savedAt: context.now,
      body: command.body,
    },
  };
};
