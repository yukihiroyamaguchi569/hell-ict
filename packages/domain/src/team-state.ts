import type { TeamCommand, TeamSnapshot, TeamState } from "./schemas/team-state.js";

export const initialTeamState = (): TeamState => ({
  mode: "peace",
  stage: "prologue",
  metrics: { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 },
});

export const initialTeamSnapshot = (teamCode: TeamSnapshot["teamCode"]): TeamSnapshot => ({
  teamCode,
  revision: 0,
  state: initialTeamState(),
});

export type TransitionResult =
  | { ok: true; snapshot: TeamSnapshot }
  | { ok: false; reason: "revision-conflict" | "forbidden-transition" };

export const transitionTeam = (snapshot: TeamSnapshot, command: TeamCommand): TransitionResult => {
  if (command.expectedRevision !== snapshot.revision) {
    return { ok: false, reason: "revision-conflict" };
  }
  if (snapshot.state.stage !== "prologue") {
    return { ok: false, reason: "forbidden-transition" };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      state: { ...snapshot.state, stage: "stage1" },
    },
  };
};
