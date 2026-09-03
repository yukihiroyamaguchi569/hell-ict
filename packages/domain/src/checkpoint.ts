import type {
  CheckpointSnapshot,
  CheckpointTrap,
  SaveCheckpointCommand,
} from "./schemas/checkpoint.js";
import type { TeamCode } from "./schemas/team-state.js";

export type CheckpointRejectionReason = "conflict" | "trap-regression" | "elapsed-regression";

export type CheckpointResult =
  | { ok: true; snapshot: CheckpointSnapshot }
  | { ok: false; reason: CheckpointRejectionReason };

/**
 * 発動済み（true）の罠フラグをfalseへ戻そうとしているかを判定する。
 * リロードやチェックポイントの書き戻しで罠をリセットできると、企画書§6の
 * 「連続罰は1回まで」が抜け道になるため、後退だけを禁止する。
 */
const regressesTrap = (current: CheckpointTrap, next: CheckpointTrap): boolean =>
  (current.s3Used && !next.s3Used) || (current.s4Used && !next.s4Used);

/**
 * チェックポイントの保存可否を決める純粋関数。`current`がnullなら未保存であり、
 * その場合のexpectedRevisionは0だけを許す（初回保存の結果はrevision 1になる）。
 * 拒否はconflict→trap→elapsedの順に判定する——revisionが合っていない保存は
 * 中身を見るまでもなく取り直しが要るため、競合を先に返す。
 */
export const applyCheckpoint = (
  current: CheckpointSnapshot | null,
  command: SaveCheckpointCommand,
  context: { teamCode: TeamCode; now: string },
): CheckpointResult => {
  const revision = current?.revision ?? 0;
  if (command.expectedRevision !== revision) return { ok: false, reason: "conflict" };
  if (current !== null && regressesTrap(current.body.trap, command.body.trap)) {
    return { ok: false, reason: "trap-regression" };
  }
  // 経過時間はサーバー側で単調増加を保証する。罰は時間で払う設計（企画書§6）なので、
  // 小さいelapsedMsを送るだけで払った時間を取り消せる抜け道を塞ぐ。同値は許可する
  // （同じ画面の再保存や再送で時計が進んでいないことがあるため）。
  if (current !== null && command.body.elapsedMs < current.body.elapsedMs) {
    return { ok: false, reason: "elapsed-regression" };
  }
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
