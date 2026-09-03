import type {
  CheckpointSnapshot,
  CheckpointTrap,
  SaveCheckpointCommand,
} from "./schemas/checkpoint.js";
import type { TeamCode } from "./schemas/team-state.js";

export type CheckpointResult =
  | { ok: true; snapshot: CheckpointSnapshot }
  | { ok: false; reason: "conflict" | "trap-regression" };

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
