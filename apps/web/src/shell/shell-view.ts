import {
  feverAfterStage2Clear,
  feverAfterStage3Trap,
  shellStages,
  type ShellMode,
} from "@hell-ict/content";
import type { GameStageId, PenaltyStatus, TeamGameViewState } from "@hell-ict/domain";

/*
 * What the common shell shows for a team's state: the colour of the frame, the fever indicator,
 * which panes are out, and the clock. Pure: the components only draw what this returns.
 * Values are the ones after each effect has played (V1 decision F), so a reload draws the same
 * frame as a team that watched the effect.
 */

/** The facts of the team's state the shell depends on. */
export interface ShellFacts {
  readonly stage: GameStageId;
  /** The current stage is cleared (its `advance` may still be pending). */
  readonly cleared: boolean;
  readonly s3Penalty: PenaltyStatus;
  /** The Prologue inbox has been opened (before that, the welcome screen has no panes). */
  readonly inboxOpened: boolean;
  /**
   * The stage's own say over the right pane (Stage 2 slides the AI in when 苅部さん switches it
   * on), or `null` for the frame's default. The welcome screen keeps no panes regardless.
   */
  readonly rightOverride: RightPane | null;
}

/** The left pane (inbox and shared folder). */
export type LeftPane = "hidden" | "shown";

/** The right pane (AI chat): `collapsed` is out of sight to the right, ready to slide in. */
export type RightPane = "hidden" | "collapsed" | "shown";

export interface ShellView {
  /** The stage the frame is drawn for (`prologue` before joining): the inbox lands rows within it. */
  readonly stage: GameStageId;
  readonly mode: ShellMode;
  readonly fever: number;
  readonly crescendo: boolean;
  readonly left: LeftPane;
  readonly right: RightPane;
}

/**
 * The facts of a team's state as the server sent it, with the stage's say over the right pane
 * (`StageInstance.rightPane`): when Stage 2's AI slides in depends on the clock and on
 * 苅部さん, which the stage itself keeps.
 */
export const shellFacts = (
  state: TeamGameViewState,
  rightOverride: RightPane | null,
): ShellFacts => {
  const { stage, clearedAt, penalties } = state.game;
  return {
    stage,
    cleared: stage !== "final" && clearedAt[stage] !== undefined,
    s3Penalty: penalties.s3,
    inboxOpened: state.inbox !== null,
    rightOverride,
  };
};

/** The welcome screen: the Prologue before the inbox is opened (mock renderWelcome). */
export const isWelcome = (state: TeamGameViewState): boolean =>
  state.game.stage === "prologue" && state.inbox === null;

/** The screen is designed at this size and scaled down to fit (mock `fit()`). */
export const SHELL_WIDTH = 1280;
export const SHELL_HEIGHT = 720;

/** The fever count after the stage's effects: +2 once Stage 2 is cleared, 12 once Stage 3 trapped. */
export const feverCount = (facts: ShellFacts): number => {
  if (facts.stage === "s2" && facts.cleared) return feverAfterStage2Clear;
  if (facts.stage === "s3" && facts.s3Penalty !== "none") return feverAfterStage3Trap;
  return shellStages[facts.stage].fever;
};

const leftPane = (facts: ShellFacts): LeftPane =>
  facts.stage === "prologue" && !facts.inboxOpened ? "hidden" : "shown";

/** Stages whose right pane does not depend on the team's progress in them. */
const FIXED_RIGHT_PANES: Readonly<Partial<Record<GameStageId, RightPane>>> = {
  s1: "collapsed",
  s3: "shown",
  s4: "shown",
  s5: "shown",
  s6: "shown",
  // Final folds the AI chat away entirely: nothing is left to ask it (mock renderFinal).
  final: "hidden",
};

const rightPane = (facts: ShellFacts): RightPane => {
  // The welcome screen has no panes; the inbox keeps the AI pane folded to the right.
  if (facts.stage === "prologue" && !facts.inboxOpened) return "hidden";
  if (facts.rightOverride !== null) return facts.rightOverride;
  if (facts.stage === "prologue") return "collapsed";
  // Stage 2 is where the AI pane first slides in (the stage overrides this when 苅部さん
  // switches it on); once the stage is cleared it stays out.
  if (facts.stage === "s2") return facts.cleared ? "shown" : "collapsed";
  return FIXED_RIGHT_PANES[facts.stage] ?? "shown";
};

export const shellView = (facts: ShellFacts): ShellView => {
  const stage = shellStages[facts.stage];
  return {
    stage: facts.stage,
    mode: stage.mode,
    fever: feverCount(facts),
    crescendo: stage.crescendo,
    left: leftPane(facts),
    right: rightPane(facts),
  };
};

/**
 * Attributes of the right pane's element. A collapsed pane is only moved out of sight, so it
 * must also leave the accessibility tree and the Tab order: its input and buttons would
 * otherwise take focus while nothing is visible. A hidden pane is `display: none` already.
 */
export const rightPaneAttrs = (
  right: RightPane,
): { readonly "aria-hidden"?: "true"; readonly inert?: true } =>
  right === "collapsed" ? { "aria-hidden": "true", inert: true } : {};

/**
 * How long the team has been racing, by the server's clock: `null` while the clock is stopped.
 * The race starts when the team accepts the director's briefing of Stage 1 (mock `s1Begin` →
 * `startClock`, the `s1.start` command here) and never stops after that — Final included, as in
 * the mock's `go()`. Before it (entry, welcome, inbox, the briefing) the clock shows `--:--`.
 */
export const raceElapsedMs = (state: TeamGameViewState, serverNowMs: number): number | null =>
  state.s1 === null ? null : serverNowMs - state.s1.stageStartedAt;

/** The race clock (mock `startClock`/`stopClock`): `--:--` while it is not running, else MM:SS. */
export const clockText = (elapsedMs: number | null): string => {
  if (elapsedMs === null || !Number.isFinite(elapsedMs)) return "--:--";
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The scale that fits the 1280-wide screen into its container, never enlarging it (mock `fit()`). */
export const fitScale = (containerWidth: number): number =>
  containerWidth > 0 ? Math.min(1, containerWidth / SHELL_WIDTH) : 1;
