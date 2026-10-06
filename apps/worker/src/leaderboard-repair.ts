import { commandResultSchema } from "@hell-ict/domain";
import type { CommandResult, TeamCode, TeamSnapshot } from "@hell-ict/domain";

/**
 * TeamRoom's leaderboard repair after a team command. This is the one place on the command
 * path that awaits: the processed row is rewritten and the snapshot broadcast only after the
 * upsert succeeds, and nothing is written when it fails.
 */

/** The part of the global leaderboard the repair calls. */
export type LeaderboardUpsert = {
  upsert(teamCode: TeamCode, snapshot: TeamSnapshot, generation: number): Promise<unknown>;
};

/**
 * What the repair needs from the DO. `leaderboard` and `readGeneration` are callbacks, not
 * values, so the leaderboard stub is fetched and the reset generation is read from SQL at the
 * same points as before the move: both while the upsert's arguments are evaluated, before the
 * await.
 */
export type LeaderboardRepairDeps = {
  readonly leaderboard: () => LeaderboardUpsert;
  readonly storage: DurableObjectStorage;
  readonly readGeneration: () => number;
  readonly broadcast: (snapshot: TeamSnapshot) => void;
};

export const repairLeaderboard = async (
  deps: LeaderboardRepairDeps,
  result: CommandResult,
  commandId: string,
): Promise<CommandResult> => {
  if (result.leaderboardPending) {
    try {
      await deps
        .leaderboard()
        .upsert(result.snapshot.teamCode, result.snapshot, deps.readGeneration());
    } catch {
      return result;
    }
    const completed = commandResultSchema.parse({ ...result, leaderboardPending: false });
    deps.storage.sql.exec(
      "UPDATE processed_commands SET result = ? WHERE command_id = ?",
      JSON.stringify(completed),
      commandId,
    );
    deps.broadcast(completed.snapshot);
    return completed;
  }
  return result;
};
