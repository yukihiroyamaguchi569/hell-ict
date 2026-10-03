import {
  inboxRepliedLabel,
  missionTitles,
  stage1RoundTags,
  stage2DeadlineLabels,
} from "@hell-ict/content";
import { INBOX_MAIL_IDS, inboxDeadlineAt, stage2DeadlineAt } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";

/*
 * The mission bar at the top of the centre pane (mock `.case.slim` and `.s2-hd`): where the team
 * is, how many are done, and the time left to the deadline. Pure: MissionBar.vue only draws it.
 * Deadlines are the server's (the clock of the countdown is the server's too), so every PC counts
 * down to the same moment.
 */

/** A countdown turns to the warning colour at this many seconds left (never red: red is for crises). */
export const HOT_SECONDS = 15;

export interface MissionDeadline {
  /** Server epoch ms. */
  readonly at: number;
  /** Words in front of the time, or `null`. */
  readonly label: string | null;
  /** What replaces the time once it has passed, or `null` to stay at 00:00. */
  readonly overText: string | null;
}

export interface MissionFacts {
  readonly title: string;
  readonly count: { readonly label: string; readonly value: string } | null;
  readonly deadline: MissionDeadline | null;
}

/**
 * What the centre pane has open (the id of the mail being read), or `null` when it shows a list
 * or nothing. The stage on screen says it (`StageInstance.focus`).
 */
export type StageFocus = string | null;

export interface Countdown {
  readonly text: string;
  readonly hot: boolean;
  readonly over: boolean;
}

/** The full-width space the mock puts between a title and its tag. */
const IDEOGRAPHIC_SPACE = "　";

/** Stage 1's attempt number as its title shows it (mock `s1AttemptNo`: R3 retries count on). */
const stage1Title = (state: TeamGameViewState): string => {
  const s1 = state.s1;
  if (s1 === null || s1.round === 1) return missionTitles.s1;
  const attempt = s1.round === 3 ? 2 + s1.r3Try : s1.round;
  const tag = `（${String(attempt)}回目・${stage1RoundTags[s1.round]}）`;
  return missionTitles.s1 + IDEOGRAPHIC_SPACE + tag;
};

const missionTitle = (state: TeamGameViewState): string =>
  state.game.stage === "s1" ? stage1Title(state) : missionTitles[state.game.stage];

const missionCount = (state: TeamGameViewState): MissionFacts["count"] =>
  state.game.stage === "prologue" && state.inbox !== null
    ? {
        label: inboxRepliedLabel,
        value: `${String(state.inbox.sent.length)} / ${String(INBOX_MAIL_IDS.length)}`,
      }
    : null;

const missionDeadline = (state: TeamGameViewState, focus: StageFocus): MissionDeadline | null => {
  // The Prologue's time left is shown only while a mail is open, as in the mock: the list of
  // three mails is the calm before anything happens.
  if (state.game.stage === "prologue" && state.inbox !== null) {
    if (focus === null) return null;
    return { at: inboxDeadlineAt(state.inbox), label: null, overText: null };
  }
  if (state.game.stage === "s2" && state.s2 !== null) {
    return {
      at: stage2DeadlineAt(state.s2),
      label: stage2DeadlineLabels.label,
      overText: stage2DeadlineLabels.over,
    };
  }
  return null;
};

export const missionFacts = (state: TeamGameViewState, focus: StageFocus): MissionFacts => ({
  title: missionTitle(state),
  count: missionCount(state),
  deadline: missionDeadline(state, focus),
});

/** Whole seconds left, rounded up as the mock's `mmss` does, and never below zero. */
export const remainingSeconds = (deadlineAt: number, nowMs: number): number =>
  Math.max(0, Math.ceil((deadlineAt - nowMs) / 1_000));

const mmss = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

export const countdown = (deadline: MissionDeadline, nowMs: number): Countdown => {
  const left = remainingSeconds(deadline.at, nowMs);
  const over = left === 0;
  if (over && deadline.overText !== null) return { text: deadline.overText, hot: false, over };
  return { text: mmss(left), hot: left <= HOT_SECONDS, over };
};
