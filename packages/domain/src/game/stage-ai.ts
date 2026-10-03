import type { ChatSnapshot, ChatThread, PromptProfile } from "../schemas/chat.js";
import type { GameStageId } from "../schemas/game.js";
import type { StageAi, StageChatCommand } from "../schemas/stage-chat.js";
import type { TeamGameState } from "../schemas/team-game.js";
import { judgeStage1DraftRequest } from "../stages/s1.js";
import type { Stage1DraftJudgement } from "../stages/s1.js";
import { buildStage1DraftText } from "../stages/s1-draft.js";

/**
 * Which AI each stage has (Issue #236). The server reads this with the team's stage, so the
 * screen never chooses the conversation or the system prompt. Ported from the mock:
 * - `STAGE_THREAD_TITLES` + `activateStageThread`: Stage 2〜6 each open a conversation of their
 *   own (kind "stage", titled "Stage N"). Stage 1 has no AI pane; its drafts go to the main
 *   conversation the team got when it joined. Prologue and Final have no AI.
 * - `sendAI` / `sendAiLive`: Stage 3, 4 and 5 send to the AI, Stage 3 with the trap's system
 *   prompt ("s3"). Stage 2 answers with the scripted table and Stage 6 makes a poster from the
 *   pre-generated candidates (`s6.generate`), so neither calls the AI.
 * - `s1DraftLive`: the draft of Stage 1 uses the "s1" system prompt.
 *
 * `thread` null is the main conversation. `live` is the one command that reaches the AI in this
 * stage, with its system prompt; `null` when nothing does.
 */
export interface StageAiPlan {
  thread: string | null;
  live: { command: StageChatCommand["type"]; profile: PromptProfile } | null;
}

const STAGE_AI = {
  prologue: null,
  s1: { thread: null, live: { command: "s1-draft", profile: "s1" } },
  s2: { thread: "Stage 2", live: null },
  s3: { thread: "Stage 3", live: { command: "stage-message", profile: "s3" } },
  s4: { thread: "Stage 4", live: { command: "stage-message", profile: "default" } },
  s5: { thread: "Stage 5", live: { command: "stage-message", profile: "default" } },
  s6: { thread: "Stage 6", live: null },
  final: null,
} as const satisfies Record<GameStageId, StageAiPlan | null>;

export const stageAiPlan = (stage: GameStageId): StageAiPlan | null => STAGE_AI[stage];

/** The title of the stage's own conversation, or null when it uses the main one or has none. */
export const stageThreadTitle = (stage: GameStageId): string | null =>
  stageAiPlan(stage)?.thread ?? null;

/**
 * The stage's conversation in the snapshot. A stage conversation is matched by kind and title
 * (the same rule as the server's de-duplication of stage threads), so a participant's manual
 * thread of the same name is never taken for it. The main one is the first thread.
 */
const findStageThread = (plan: StageAiPlan, snapshot: ChatSnapshot): ChatThread | undefined =>
  plan.thread === null
    ? snapshot.threads[0]
    : snapshot.threads.find((thread) => thread.kind === "stage" && thread.title === plan.thread);

export const stageAiView = (stage: GameStageId, snapshot: ChatSnapshot): StageAi => {
  const plan = stageAiPlan(stage);
  if (plan === null) return { status: "none" };
  const thread = findStageThread(plan, snapshot);
  if (thread === undefined) return { status: "failed" };
  return { status: "ready", threadId: thread.threadId, live: plan.live !== null };
};

export type StageChatTarget =
  | { ok: true; threadId: string; promptProfile: PromptProfile }
  | { ok: false; reason: "no-ai-chat" | "thread-not-ready" };

/**
 * Where a command of the stage chat goes, decided by the team's stage alone. A command this
 * stage does not send to the AI (a draft outside Stage 1, a message in Stage 2) is refused, and
 * so is a message while the stage's conversation is missing: it must not fall back to another
 * stage's conversation (Issue #85).
 */
export const resolveStageChatTarget = (
  stage: GameStageId,
  snapshot: ChatSnapshot,
  command: StageChatCommand["type"],
): StageChatTarget => {
  const plan = stageAiPlan(stage);
  if (plan?.live?.command !== command) return { ok: false, reason: "no-ai-chat" };
  const thread = findStageThread(plan, snapshot);
  if (thread === undefined) return { ok: false, reason: "thread-not-ready" };
  return { ok: true, threadId: thread.threadId, promptProfile: plan.live.profile };
};

export type StageChatText =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: Extract<Stage1DraftJudgement, { outcome: "reject" }>["reason"] | "not-started";
    };

/**
 * The text that goes to the AI. A message is sent as it is. A Stage 1 draft passes the gate of
 * [AIに下書きさせる] first (judgeStage1DraftRequest, on the server's clock and Stage 1 state):
 * when it does not, nothing reaches the AI. Call only after `resolveStageChatTarget` has placed
 * the command in its stage.
 */
export const stageChatText = (
  state: TeamGameState,
  command: StageChatCommand,
  nowMs: number,
): StageChatText => {
  if (command.type === "stage-message") return { ok: true, text: command.text };
  if (state.s1 === null) return { ok: false, reason: "not-started" };
  const gate = judgeStage1DraftRequest(state.s1, command.mailId, command, nowMs);
  if (gate.outcome === "reject") return { ok: false, reason: gate.reason };
  const text = buildStage1DraftText(command.mailId, command, gate.source === "context");
  return text === null ? { ok: false, reason: "not-in-round" } : { ok: true, text };
};
