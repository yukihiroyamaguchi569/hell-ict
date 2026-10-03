import { gameStagePosition, GAME_STAGE_IDS } from "../schemas/game.js";
import type {
  GameCommand,
  GameEvent,
  GameInstant,
  GameStageId,
  JudgedStageId,
  StageJudgement,
} from "../schemas/game.js";
import type {
  TeamGameCommand,
  TeamGameCommandType,
  TeamGameRejectionReason,
  TeamGameStanding,
  TeamGameState,
} from "../schemas/team-game.js";
import { redactPii } from "../pii.js";
import { judgePrologue, sendInboxReply, startInbox } from "../stages/inbox.js";
import {
  acknowledgeStage1RoundResult,
  judgeStage1,
  sendStage1MemoReply,
  sendStage1Reply,
  settleStage1Round,
  startStage1,
} from "../stages/s1.js";
import type { Stage1ReplyResult, Stage1State } from "../stages/s1.js";
import { judgeStage2, startStage2, takeStage2Addendum } from "../stages/s2.js";
import { countStage3TrapJudgements, judgeStage3 } from "../stages/s3.js";
import { judgeStage4Action, judgeStage4Summary } from "../stages/s4.js";
import { judgeS5Report } from "../stages/s5-report.js";
import { judgeS5AiMessage, judgeS5Submission } from "../stages/s5.js";
import { isS6PromptCopiedFromMail, judgeS6Submission, selectS6PosterType } from "../stages/s6.js";
import { toStageJudgement } from "../stages/stage-judgement.js";
import { applyGameCommand, initialGameState } from "./apply-game-command.js";

/**
 * Applies one command of the screen to a team's whole game (Issue #234). Pure: the only clock
 * is `now`, read once by the server, and nothing outside the returned value changes.
 *
 * Each command runs its stage's judge (D2〜D4) and, when the judge decides the stage, wraps the
 * outcome into D1's `record-judgement` under the same commandId. D1 then decides whether that
 * outcome may count at all (a stale tab, a running penalty — Issue #92), so no rule of D1 is
 * repeated here. A command maps to at most one D1 command.
 *
 * Resends are the caller's job (the server's ledger): this function sees every command as new.
 */

/**
 * - applied: the state changed (or a judge ran and accepted without changing anything).
 * - rejected: nothing changed; `reason` says why. A rejected command may be sent again later.
 * `judgement` is the stage judge's full result (ids, never the submitted text), when one ran.
 */
export type TeamGameResult =
  | { status: "applied"; state: TeamGameState; events: GameEvent[]; judgement: unknown }
  | { status: "rejected"; reason: TeamGameRejectionReason; judgement: unknown };

export interface TeamGameNow {
  /** The server's clock as epoch ms, for the stage clocks (inbox, Stage 1, Stage 2). */
  ms: number;
  /** The same instant as D1's instant. */
  at: GameInstant;
}

export const initialTeamGameState = (now: GameInstant): TeamGameState => ({
  game: initialGameState(),
  startedAt: now,
  enteredAt: {},
  inbox: null,
  s1: null,
  s2: null,
  s3: { trapJudgements: 0 },
  s4: { summaryAccepted: false },
  s6: { promptLog: [], candidates: [] },
});

interface Context {
  state: TeamGameState;
  command: TeamGameCommand;
  now: TeamGameNow;
}

const rejected = (reason: TeamGameRejectionReason, judgement: unknown = null): TeamGameResult => ({
  status: "rejected",
  reason,
  judgement,
});

const applied = (state: TeamGameState, judgement: unknown = null): TeamGameResult => ({
  status: "applied",
  state,
  events: [],
  judgement,
});

/** A stage entered by `advance` gets its entry time: `final` is the goal of the race. */
const withEntries = (
  enteredAt: TeamGameState["enteredAt"],
  events: readonly GameEvent[],
): TeamGameState["enteredAt"] => {
  const entries = { ...enteredAt };
  for (const event of events) {
    if (event.type === "stage-entered" && event.stage !== "prologue") {
      entries[event.stage] = event.at;
    }
  }
  return entries;
};

/**
 * Hands one command to D1 under the screen command's id. `next` is the stage state the command
 * leads to; it is kept only if D1 applies the command, so a stale tab cannot move a stage clock.
 */
const toStateMachine = (
  ctx: Context,
  command: GameCommand,
  next: { state?: TeamGameState; judgement?: unknown } = {},
): TeamGameResult => {
  const result = applyGameCommand(ctx.state.game, command, ctx.now.at);
  if (result.verdict.status === "rejected") return rejected(result.verdict.reason);
  // The server's ledger answers resends before this, so D1 only sees a duplicate if the two
  // disagree. D1 has applied it before; the stage state must not move a second time.
  if (result.verdict.status === "duplicate") return applied(ctx.state);
  const base = next.state ?? ctx.state;
  return {
    status: "applied",
    state: { ...base, game: result.state, enteredAt: withEntries(base.enteredAt, result.events) },
    events: result.events,
    judgement: next.judgement ?? null,
  };
};

const recordJudgement = (
  ctx: Context,
  stage: JudgedStageId,
  judgement: StageJudgement,
  next: { state?: TeamGameState; judgement?: unknown } = {},
): TeamGameResult =>
  toStateMachine(
    ctx,
    {
      type: "record-judgement",
      commandId: ctx.command.commandId,
      stage,
      judgement: toStageJudgement(judgement),
    },
    { judgement, ...next },
  );

/**
 * Stage-internal steps (a reply, a start, a generated poster) are for the stage the team is in,
 * and only while it is not cleared yet. D1 checks the same for everything it records.
 */
const stageBlocker = (state: TeamGameState, stage: GameStageId): TeamGameRejectionReason | null => {
  if (state.game.stage !== stage) return "stage-mismatch";
  if (stage !== "final" && state.game.clearedAt[stage] !== undefined) return "already-cleared";
  return null;
};

// ---- Prologue ----

const openInbox = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "prologue");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.inbox !== null) return rejected("already-started");
  return applied({ ...ctx.state, inbox: startInbox(ctx.now.ms) });
};

/** The Prologue is cleared once no mail is open (the mock moves on to Stage 1 then). */
const finishPrologueIfDone = (
  ctx: Context,
  state: TeamGameState,
  judgement: unknown,
): TeamGameResult => {
  if (state.inbox === null) return applied(state, judgement);
  const prologue = judgePrologue(state.inbox, ctx.now.ms);
  if (prologue.outcome !== "pass") return applied(state, judgement);
  return recordJudgement(ctx, "prologue", prologue, { state, judgement });
};

const replyInInbox = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "inbox.reply" }>,
): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "prologue");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.inbox === null) return rejected("not-started");
  const reply = sendInboxReply(ctx.state.inbox, command.mailId, command.text, ctx.now.ms);
  if (reply.judgement.outcome === "reject")
    return rejected(reply.judgement.reason, reply.judgement);
  return finishPrologueIfDone(ctx, { ...ctx.state, inbox: reply.state }, reply.judgement);
};

const settleInbox = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "prologue");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.inbox === null) return rejected("not-started");
  const prologue = judgePrologue(ctx.state.inbox, ctx.now.ms);
  if (prologue.outcome !== "pass") return rejected("mails-open", prologue);
  return recordJudgement(ctx, "prologue", prologue);
};

// ---- Stage 1 ----

/** The Stage 1 state after the clock has had its say (a round may have ended meanwhile). */
const settledStage1 = (ctx: Context): Stage1State | TeamGameRejectionReason => {
  const blocker = stageBlocker(ctx.state, "s1");
  if (blocker !== null) return blocker;
  if (ctx.state.s1 === null) return "not-started";
  return settleStage1Round(ctx.state.s1, ctx.now.ms).state;
};

/** A round cleared by the latest step clears the stage: its `pass` goes to D1 at once. */
const finishStage1IfCleared = (
  ctx: Context,
  s1: Stage1State,
  judgement: unknown,
): TeamGameResult => {
  const state = { ...ctx.state, s1 };
  const stage1 = judgeStage1(s1);
  if (stage1.outcome !== "pass") return applied(state, judgement);
  return recordJudgement(ctx, "s1", stage1, { state, judgement });
};

const startStage1Command = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s1");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.s1 !== null) return rejected("already-started");
  return applied({ ...ctx.state, s1: startStage1(ctx.now.ms) });
};

/**
 * The curt replies are kept for the round's result window. They are stored on the server and
 * sent back by GET, so personal data in them is blacked out first (as the chat stores AI
 * answers). Judging has already run on the original text.
 */
const withRedactedCurt = (s1: Stage1State): Stage1State => ({
  ...s1,
  curt: s1.curt.map((entry) => ({ ...entry, reply: redactPii(entry.reply) })),
});

const afterStage1Reply = (ctx: Context, reply: Stage1ReplyResult): TeamGameResult => {
  if (reply.judgement.outcome === "reject")
    return rejected(reply.judgement.reason, reply.judgement);
  const settled = settleStage1Round(withRedactedCurt(reply.state), ctx.now.ms);
  return finishStage1IfCleared(ctx, settled.state, {
    ...reply.judgement,
    settlement: settled.settlement,
  });
};

const replyInStage1 = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s1.reply" }>,
): TeamGameResult => {
  const s1 = settledStage1(ctx);
  if (typeof s1 === "string") return rejected(s1);
  return afterStage1Reply(ctx, sendStage1Reply(s1, command.mailId, command.text, ctx.now.ms));
};

const replyToStage1Memo = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s1.memo-reply" }>,
): TeamGameResult => {
  const s1 = settledStage1(ctx);
  if (typeof s1 === "string") return rejected(s1);
  return afterStage1Reply(ctx, sendStage1MemoReply(s1, command.text, ctx.now.ms));
};

const settleStage1 = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s1");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.s1 === null) return rejected("not-started");
  const settled = settleStage1Round(ctx.state.s1, ctx.now.ms);
  if (settled.settlement.type === "none") return rejected("round-not-over");
  return finishStage1IfCleared(ctx, settled.state, { settlement: settled.settlement });
};

const nextStage1Round = (ctx: Context): TeamGameResult => {
  const s1 = settledStage1(ctx);
  if (typeof s1 === "string") return rejected(s1);
  const next = acknowledgeStage1RoundResult(s1, ctx.now.ms);
  if (next === null) return rejected("no-round-result");
  return applied({ ...ctx.state, s1: next });
};

// ---- Stage 2 ----

const startStage2Command = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s2");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.s2 !== null) return rejected("already-started");
  return applied({ ...ctx.state, s2: startStage2(ctx.now.ms) });
};

/**
 * [表に追加]. The grid lives on the screen, so only the flag is kept here; the screen appends
 * the addendum rows (content) when this is applied.
 */
const takeAddendum = (ctx: Context): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s2");
  if (blocker !== null) return rejected(blocker);
  if (ctx.state.s2 === null) return rejected("not-started");
  const taken = takeStage2Addendum(ctx.state.s2, [], [], ctx.now.ms);
  if (taken.judgement.outcome === "reject")
    return rejected(taken.judgement.reason, taken.judgement);
  return applied({ ...ctx.state, s2: taken.state }, taken.judgement);
};

const submitStage2 = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s2.submit" }>,
): TeamGameResult => {
  if (ctx.state.s2 === null) {
    return rejected(stageBlocker(ctx.state, "s2") ?? "not-started");
  }
  return recordJudgement(ctx, "s2", judgeStage2(command.grid, ctx.state.s2, ctx.now.ms));
};

// ---- Stage 3 ----

/**
 * The Stage 3 trap judgements so far. A state saved before the count existed reads 0 even when
 * the trap has fired; the fired trap is then the one judgement it certainly had. Repeats before
 * the count existed left no trace in the state, so such a team may get its hints later than a
 * new one (known limit, accepted: only games running across the deploy of this change, and the
 * count is never ahead of the truth, so no hint comes early).
 */
const stage3TrapJudgementsSoFar = (state: TeamGameState): number =>
  Math.max(state.s3.trapJudgements, state.game.penalties.s3 === "none" ? 0 : 1);

/**
 * A trap that D1 recorded is counted (Issue #219); the screen reads the hint with
 * `stage3TrapHint(events, state.s3.trapJudgements)`. A reject, a pass, a resend and a trap
 * rejected during the penalty record no trap, so the count does not move.
 */
const submitStage3 = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s3.submit" }>,
): TeamGameResult => {
  const result = recordJudgement(ctx, "s3", judgeStage3(command.submission));
  if (result.status !== "applied") return result;
  const traps = countStage3TrapJudgements(result.events);
  if (traps === 0) return result;
  const trapJudgements = stage3TrapJudgementsSoFar(ctx.state) + traps;
  return { ...result, state: { ...result.state, s3: { trapJudgements } } };
};

/** The bottles are filled on the screen; D1 checks that a penalty is running at all. */
const finishStage3Penalty = (ctx: Context): TeamGameResult =>
  toStateMachine(ctx, {
    type: "complete-penalty",
    commandId: ctx.command.commandId,
    stage: "s3",
  });

// ---- Stage 4 ----

const submitStage4Summary = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s4.submit-summary" }>,
): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s4");
  if (blocker !== null) return rejected(blocker);
  const summary = judgeStage4Summary(command.text);
  if (summary.outcome === "reject") return rejected(summary.reason, summary);
  return applied({ ...ctx.state, s4: { summaryAccepted: true } }, summary);
};

/** The director asks for an action only after the summary passed (the mock's order). */
const submitStage4Action = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s4.submit-action" }>,
): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s4");
  if (blocker !== null) return rejected(blocker);
  if (!ctx.state.s4.summaryAccepted) return rejected("summary-first");
  return recordJudgement(ctx, "s4", judgeStage4Action(command.text));
};

// ---- Stage 5 ----

/** A clean message passes the gate (`judgement` null). A hit is the trap, recorded by D1. */
const checkStage5AiMessage = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s5.check-ai-message" }>,
): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s5");
  if (blocker !== null) return rejected(blocker);
  const gate = judgeS5AiMessage(command.text);
  return gate === null ? applied(ctx.state) : recordJudgement(ctx, "s5", gate);
};

const submitStage5 = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s5.submit" }>,
): TeamGameResult => recordJudgement(ctx, "s5", judgeS5Submission(command.text));

/** The Stage 5 penalty ends only with a report that blacks out exactly the personal data. */
const submitStage5Report = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s5.submit-report" }>,
): TeamGameResult => {
  if (ctx.state.game.penalties.s5 !== "in-progress") return rejected("no-penalty-in-progress");
  const report = judgeS5Report(command.maskedIndices);
  if (report.outcome === "reject") return rejected("report-incomplete", report);
  return toStateMachine(
    ctx,
    { type: "complete-penalty", commandId: ctx.command.commandId, stage: "s5" },
    { judgement: report },
  );
};

// ---- Stage 6 ----

/**
 * One instruction to the image AI. A mail pasted as it is is sent back without a poster and
 * does not enter the log (the mock's `s6Generate`). No limit on the number of generations.
 */
const generateStage6Poster = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s6.generate" }>,
): TeamGameResult => {
  const blocker = stageBlocker(ctx.state, "s6");
  if (blocker !== null) return rejected(blocker);
  if (command.prompt.trim() === "") return rejected("empty");
  if (isS6PromptCopiedFromMail(command.prompt)) return rejected("copied-from-mail");
  const { promptLog, candidates } = ctx.state.s6;
  const type = selectS6PosterType(command.prompt, candidates.at(-1) ?? null);
  return applied(
    {
      ...ctx.state,
      // The log is stored and sent back by GET: personal data is blacked out before it is kept.
      // The requirements (mask, visiting hours) never match the black-out, so judging is unchanged.
      s6: {
        promptLog: [...promptLog, redactPii(command.prompt)],
        candidates: [...candidates, type],
      },
    },
    { index: candidates.length, type },
  );
};

const submitStage6 = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "s6.submit" }>,
): TeamGameResult => {
  const candidate = ctx.state.s6.candidates[command.candidateIndex];
  if (candidate === undefined) return rejected("no-candidate");
  return recordJudgement(ctx, "s6", judgeS6Submission(candidate, ctx.state.s6.promptLog));
};

// ---- Moving on ----

const advance = (
  ctx: Context,
  command: Extract<TeamGameCommand, { type: "advance" }>,
): TeamGameResult =>
  toStateMachine(ctx, {
    type: "advance",
    commandId: command.commandId,
    from: command.from,
    to: command.to,
  });

type CommandOf<T extends TeamGameCommandType> = Extract<TeamGameCommand, { type: T }>;

type Handlers = {
  [T in TeamGameCommandType]: (ctx: Context, command: CommandOf<T>) => TeamGameResult;
};

const HANDLERS: Handlers = {
  "inbox.open": openInbox,
  "inbox.reply": replyInInbox,
  "inbox.settle": settleInbox,
  "s1.start": startStage1Command,
  "s1.reply": replyInStage1,
  "s1.memo-reply": replyToStage1Memo,
  "s1.settle": settleStage1,
  "s1.next-round": nextStage1Round,
  "s2.start": startStage2Command,
  "s2.take-addendum": takeAddendum,
  "s2.submit": submitStage2,
  "s3.submit": submitStage3,
  "s3.finish-penalty": finishStage3Penalty,
  "s4.submit-summary": submitStage4Summary,
  "s4.submit-action": submitStage4Action,
  "s5.check-ai-message": checkStage5AiMessage,
  "s5.submit": submitStage5,
  "s5.submit-report": submitStage5Report,
  "s6.generate": generateStage6Poster,
  "s6.submit": submitStage6,
  advance,
};

/** Correlates the command with its own handler (TypeScript cannot pair them in a union). */
const dispatch = <T extends TeamGameCommandType>(
  handlers: Handlers,
  ctx: Context,
  command: CommandOf<T> & { type: T },
): TeamGameResult => {
  const handler: Handlers[T] = handlers[command.type];
  return handler(ctx, command);
};

export const applyTeamGameCommand = (
  state: TeamGameState,
  command: TeamGameCommand,
  now: TeamGameNow,
): TeamGameResult => dispatch(HANDLERS, { state, command, now }, command);

/**
 * The stop on the race band (the mock's `pos`): the stage's position, one more once the stage is
 * cleared (the mock moves the team's piece at the clear, before the next stage opens).
 */
export const teamGamePosition = (state: TeamGameState): number => {
  const { stage, clearedAt } = state.game;
  const cleared = stage !== "final" && clearedAt[stage] !== undefined;
  return gameStagePosition(stage) + (cleared ? 1 : 0);
};

export const teamGameStanding = (state: TeamGameState): TeamGameStanding => {
  const pos = teamGamePosition(state);
  // Every stage behind `pos` is cleared (D1's invariant), so only pos 0 falls back.
  const clearedStage = GAME_STAGE_IDS[pos - 1];
  const clearedAt =
    clearedStage === undefined || clearedStage === "final"
      ? undefined
      : state.game.clearedAt[clearedStage];
  return {
    stage: state.game.stage,
    pos,
    reachedAt: clearedAt ?? state.startedAt,
    finishedAt: state.enteredAt.final ?? null,
  };
};

/**
 * The latest instant the race has recorded for the team (the start, each entry, each clear),
 * as epoch ms. The server never applies a command at an earlier time, so that clears, entries
 * and the goal stay in the order they were applied (the ranking uses these times).
 */
export const teamGameLatestMs = (state: TeamGameState): number =>
  Math.max(
    Date.parse(state.startedAt),
    ...Object.values(state.enteredAt).map((at) => Date.parse(at)),
    ...Object.values(state.game.clearedAt).map((at) => Date.parse(at)),
  );
