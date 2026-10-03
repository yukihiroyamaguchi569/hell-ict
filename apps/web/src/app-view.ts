import type { TeamGameScene, TeamGameViewState } from "@hell-ict/domain";

import type { GameSessionStatus, GameView } from "./composables/use-game-session.js";
import { missionFacts, type MissionFacts, type StageFocus } from "./shell/mission-bar-view.js";
import {
  isWelcome,
  shellFacts,
  shellView,
  type RightPane,
  type ShellFacts,
  type ShellView,
} from "./shell/shell-view.js";
import type { StageModule } from "./stages/stage-module.js";

/*
 * Which screen the app shows. Pure: App.vue only draws what this returns.
 * - entry: no team on screen yet (first visit, a restore under way or failed, a join refused).
 *   Nothing that writes is on screen until the join has gone through.
 * - welcome / game: the team's game (`centerView` says what the centre shows).
 * - stale: the game as it was, under a notice that asks for a reload.
 */
export type AppScreen = "entry" | "welcome" | "game" | "stale";

export const appScreen = (status: GameSessionStatus, view: GameView | null): AppScreen => {
  if (status === "stale") return "stale";
  if (status !== "ready" || view === null) return "entry";
  return isWelcome(view.state) ? "welcome" : "game";
};

/** Before any team: the frame of a team that has just started (peace, no panes). */
const NOT_JOINED: ShellFacts = {
  stage: "prologue",
  cleared: false,
  s3Penalty: "none",
  inboxOpened: false,
  rightOverride: null,
};

/** `rightOverride`: the stage's say over the right pane (`StageFrame.rightOverride`). */
export const appShellView = (view: GameView | null, rightOverride: RightPane | null): ShellView =>
  shellView(view === null ? NOT_JOINED : shellFacts(view.state, rightOverride));

/**
 * What the centre pane shows.
 * - welcome: the welcome screen, until 「メールを開く」.
 * - coming-soon: 「この先は準備中です」: the stage has no module yet. Pressing 「メールを開く」
 *   while the Prologue has none leads here too, without sending `inbox.open`.
 * - stage: the stage's own centre (`StageInstance.center`).
 * - none: nothing (entry, a stale tab).
 */
export type CenterView = "none" | "welcome" | "coming-soon" | "stage";

export const centerView = (
  screen: AppScreen,
  module: StageModule | null,
  welcomeLeft: boolean,
): CenterView => {
  if (screen === "welcome") return module === null && welcomeLeft ? "coming-soon" : "welcome";
  if (screen === "game") return module === null ? "coming-soon" : "stage";
  return "none";
};

/**
 * What 「メールを開く」 does: sends `inbox.open` when the Prologue is built, else only shows
 * 「この先は準備中です」 (nothing written for a stage that is not there).
 */
export const welcomeAction = (prologue: StageModule | null): "send-inbox-open" | "coming-soon" =>
  prologue === null ? "coming-soon" : "send-inbox-open";

/** The mission bar: the frame's facts, with the deadline of the stage's own when it has one. */
export const stageMissionFacts = (
  state: TeamGameViewState,
  focus: StageFocus,
  module: StageModule | null,
): MissionFacts => {
  const facts = missionFacts(state, focus);
  const own = module?.missionDeadline;
  return own === undefined ? facts : { ...facts, deadline: own(state, focus) };
};

/**
 * The scene the clear effect plays from: none for a stage without a module. The effect's last
 * button sends `advance`, and a stage that is not built must send nothing, even when the server
 * already has it cleared (a team moved on by the API, or a test fixture). None either while the
 * stage holds the effect back (`StageInstance.holdClear`): its own window comes first.
 */
export const clearEffectScene = (
  scene: TeamGameScene | null,
  module: StageModule | null,
  held: boolean,
): TeamGameScene | null => (module === null || held ? null : scene);
