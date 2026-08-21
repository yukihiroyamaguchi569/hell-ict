import { STAGE1_ROUND1_EMAILS, judgeStage1Reply, stage1EmailStatus } from "./stage1.js";
import type {
  SubmitStage1ReplyCommand,
  TeamCommand,
  TeamSnapshot,
  TeamState,
} from "./schemas/team-state.js";

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
  | {
      ok: false;
      reason:
        | "revision-conflict"
        | "forbidden-transition"
        | "unknown-email"
        | "already-resolved"
        | "email-expired";
    };

const applyEnterStage1 = (snapshot: TeamSnapshot, now: Date): TransitionResult => {
  if (snapshot.state.stage !== "prologue") {
    return { ok: false, reason: "forbidden-transition" };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      state: {
        ...snapshot.state,
        stage: "stage1",
        stage1: { roundStartedAt: now.toISOString(), replies: [] },
      },
    },
  };
};

const applySubmitStage1Reply = (
  snapshot: TeamSnapshot,
  command: SubmitStage1ReplyCommand,
  now: Date,
): TransitionResult => {
  if (snapshot.state.stage !== "stage1") {
    return { ok: false, reason: "forbidden-transition" };
  }
  const { stage1 } = snapshot.state;
  const email = STAGE1_ROUND1_EMAILS.find((candidate) => candidate.id === command.emailId);
  if (email === undefined) return { ok: false, reason: "unknown-email" };
  const status = stage1EmailStatus(email, stage1.replies, stage1.roundStartedAt, now);
  if (status === "replied") return { ok: false, reason: "already-resolved" };
  if (status === "expired") return { ok: false, reason: "email-expired" };
  const polite = judgeStage1Reply(command.text);
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      state: {
        ...snapshot.state,
        stage1: {
          ...stage1,
          replies: [...stage1.replies, { emailId: command.emailId, polite }],
        },
      },
    },
  };
};

export const transitionTeam = (
  snapshot: TeamSnapshot,
  command: TeamCommand,
  now: Date,
): TransitionResult => {
  if (command.expectedRevision !== snapshot.revision) {
    return { ok: false, reason: "revision-conflict" };
  }
  if (command.type === "enter-stage1") {
    return applyEnterStage1(snapshot, now);
  }
  return applySubmitStage1Reply(snapshot, command, now);
};
