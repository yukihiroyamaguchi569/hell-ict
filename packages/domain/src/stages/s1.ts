import { stage1Rules } from "@hell-ict/content";
import { z } from "zod";

import type { StageJudgement } from "../schemas/game.js";
import { DEADLINE_GRACE_MS, epochMsSchema, isPastDeadline, secondsToMs } from "./deadline.js";

/**
 * Stage 1 (inbox hell): three rounds of five mails, each to be answered within a minute.
 * Ported from the mock's `S1_LIMIT` / `S1_MIN_LEN` / `S1_POLITE`,
 * the `id`/`at` of `S1_MAILS_R1..R3`, `s1Init`, `s1Frame`, `s1Send`, `s1SendMemo`,
 * `s1RoundComplete`, `s1DeliverAIAndRetry`, `s1StartRound3`, `s1RetryRound3`, `s1Result`,
 * `s1AttemptNo`, `s1MemoLive` and the draft gate of `s1Draft` (hell-ict-archive:docs/ui/mock/index.html).
 *
 * - R1 (no AI), R2 (AI drafts), R3 (context): a round ends once every mail has landed and none
 *   is still open. All five answered, none curt or pasted → cleared; otherwise the next round.
 * - R3 repeats with the same five mails until it is cleared, with no limit.
 * - A reply is judged on length and politeness, and on whether it copies the handover memo
 *   (#44, not in the mock), never on what it answers. A curt or pasted reply is not refused: it
 *   counts against the round when the round ends.
 * - The handover memo expires once, 60 s after the stage started, whatever the round. Replying
 *   to it is never judged and does not count for the round.
 *
 * The mock's `S1_SAFETY` (R2 ends by force after 240 s) is not ported: by then every mail has
 * landed and expired, so the round is over on its own and the rule can never change anything.
 *
 * Time is never stored as "landed" or "missed": both follow from the round's start and `now`.
 * The mock lands a mail on the first 250 ms frame at or after its `at` and starts its minute
 * then (the first mail of a round always 0.25 s late); here a mail lands exactly at `at` and is
 * due exactly 60 s later. Unlike the mock, the server keeps a mail (and the memo) open for
 * `DEADLINE_GRACE_MS` after its deadline, so an untouched round ends at 85 s instead of 83 s.
 */

/** The mock's `S1_LIMIT`: each mail's minute, counted from its landing. */
export const STAGE1_REPLY_LIMIT_MS = secondsToMs(60);

/** The mock's `S1_MIN_LEN`: a reply shorter than this is curt. */
export const STAGE1_MIN_REPLY_LENGTH = 70;

/** The mock's `S1_POLITE`: a reply with none of these is curt. */
const POLITE = /(ます|ください|いたし|ございま|よろしく|お願い|存じ)/;

/** The memo and the run that makes a reply a paste of it live in content (`stage1Rules`). */
const PASTED_MEMO: { text: string; minRun: number } = stage1Rules.pastedMemo;

export const STAGE1_ROUNDS = [1, 2, 3] as const;

export const stage1RoundSchema = z.literal(STAGE1_ROUNDS);

export type Stage1Round = z.infer<typeof stage1RoundSchema>;

/** Every mail of the three rounds, in round and landing order (the same ids as the mock). */
export const STAGE1_MAIL_IDS = [
  "m1",
  "m2",
  "m3",
  "m4",
  "m8",
  "r1",
  "r2",
  "r3",
  "r7",
  "r9",
  "t1",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

export const stage1MailIdSchema = z.enum(STAGE1_MAIL_IDS);

export type Stage1MailId = z.infer<typeof stage1MailIdSchema>;

/** Landing offsets (seconds after the round starts) of each round's mails, in landing order. */
export const STAGE1_SCHEDULES = {
  1: [
    { id: "m1", at: 0 },
    { id: "m2", at: 5 },
    { id: "m3", at: 11 },
    { id: "m4", at: 17 },
    { id: "m8", at: 23 },
  ],
  2: [
    { id: "r1", at: 0 },
    { id: "r2", at: 5 },
    { id: "r3", at: 11 },
    { id: "r7", at: 17 },
    { id: "r9", at: 23 },
  ],
  3: [
    { id: "t1", at: 0 },
    { id: "t3", at: 5 },
    { id: "t4", at: 11 },
    { id: "t5", at: 17 },
    { id: "t6", at: 23 },
  ],
} as const satisfies Record<Stage1Round, readonly { id: Stage1MailId; at: number }[]>;

/** What a round ended with (the mock's `s1ShowResultWin` kinds). */
export const STAGE1_ROUND_FAILURES = ["round1", "round2", "round3"] as const;

export const STAGE1_CLEAR_RESULTS = ["manual", "ai"] as const;

/**
 * - playing: the mails are landing (the mock's frame is running).
 * - round-result: the round failed and its result window waits for the button. The mock stops its
 *   frame while the window is open; here nothing needs stopping, since a round only ends once
 *   every mail has landed and is done or missed, and neither can change afterwards.
 * - cleared: the stage is cleared (`manual` in R1 without AI, `ai` in R2/R3).
 */
const phaseSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("playing") }).strict(),
  z
    .object({
      phase: z.literal("round-result"),
      failure: z.enum(STAGE1_ROUND_FAILURES),
    })
    .strict(),
  z
    .object({
      phase: z.literal("cleared"),
      result: z.enum(STAGE1_CLEAR_RESULTS),
    })
    .strict(),
]);

/**
 * - stageStartedAt: when the team pressed [了解しました] (the mock's first `s1.t0`); the memo's
 *   deadline counts from here and is never reset.
 * - roundStartedAt: the mock's `s1.t0`, reset at each round and each R3 retry.
 * - r3Try: 0 in R1/R2, 1 on the first R3, +1 per retry (the mock's `s1.r3Try`).
 * - doneIds: every mail answered so far, over all rounds (the mock's `s1.doneIds`). An R3 retry
 *   removes the R3 mails, or the last try's replies would count for this one.
 * - curt: this round's curt replies with their text, for the result window (the mock's `s1.curt`).
 * - pasted: this round's replies that copy the handover memo (#44), kept like `curt`. A reply is
 *   in one of the two at most. Missing in states saved before it existed: read as empty.
 */
/** A reply kept for the result window (curt or pasted). */
const stage1JudgedReplySchema = z
  .object({ mailId: stage1MailIdSchema, reply: z.string() })
  .strict();

const stage1StateShapeSchema = z
  .object({
    stageStartedAt: epochMsSchema,
    round: stage1RoundSchema,
    roundStartedAt: epochMsSchema,
    r3Try: z.number().int().nonnegative(),
    doneIds: z.array(stage1MailIdSchema),
    curt: z.array(stage1JudgedReplySchema),
    pasted: z.array(stage1JudgedReplySchema).default([]),
    memoReplied: z.boolean(),
    status: phaseSchema,
  })
  .strict();

type Stage1StateShape = z.infer<typeof stage1StateShapeSchema>;

const ROUND_FAILURES = { 1: "round1", 2: "round2", 3: "round3" } as const;

const roundMailIds = (round: Stage1Round): readonly Stage1MailId[] =>
  STAGE1_SCHEDULES[round].map((mail) => mail.id);

/** All five of this round answered and none of them curt or pasted (the mock's `clean`). */
const isCleanRound = (state: Stage1StateShape): boolean =>
  roundMailIds(state.round).every((id) => state.doneIds.includes(id)) &&
  state.curt.length === 0 &&
  state.pasted.length === 0;

/** Replies can only have gone to the rounds played so far, and a round starts after the stage. */
const historyIsPlayed = (state: Stage1StateShape): boolean => {
  const played = STAGE1_ROUNDS.filter((round) => round <= state.round).flatMap(roundMailIds);
  return (
    state.doneIds.every((id) => played.includes(id)) && state.roundStartedAt >= state.stageStartedAt
  );
};

/**
 * A curt or pasted reply is a reply of this round (the lists are emptied when a round starts),
 * and no reply is in both.
 */
const judgedRepliesAreThisRound = (state: Stage1StateShape): boolean => {
  const ids = [...state.curt, ...state.pasted].map(({ mailId }) => mailId);
  return (
    new Set(ids).size === ids.length &&
    ids.every((id) => roundMailIds(state.round).includes(id) && state.doneIds.includes(id))
  );
};

/**
 * The phase agrees with the round: a failed round's window names that round and the round is
 * not clean (the mock's `s1RoundComplete` clears a clean round instead), and a cleared
 * stage has a clean round with the result that round gives (manual in R1, ai after).
 */
const phaseMatchesRound = (state: Stage1StateShape): boolean => {
  const { status } = state;
  if (status.phase === "round-result") {
    return status.failure === ROUND_FAILURES[state.round] && !isCleanRound(state);
  }
  if (status.phase === "cleared") {
    return isCleanRound(state) && status.result === (state.round === 1 ? "manual" : "ai");
  }
  return true;
};

/**
 * The invariants are part of the schema, as in D1's `gameStateSchema`, so that a state read back
 * from storage cannot claim a clear or a round its own transitions never lead to.
 */
export const stage1StateSchema = stage1StateShapeSchema
  .refine((state) => new Set(state.doneIds).size === state.doneIds.length, {
    message: "doneIds has duplicates",
  })
  .refine((state) => (state.round === 3) === state.r3Try > 0, {
    message: "r3Try must be positive exactly in round 3",
  })
  .refine(historyIsPlayed, { message: "doneIds or the round start is ahead of the round" })
  .refine(judgedRepliesAreThisRound, { message: "curt or pasted holds a reply outside this round" })
  .refine(phaseMatchesRound, { message: "phase does not match the round" });

export type Stage1State = z.infer<typeof stage1StateSchema>;

export type Stage1MailStatus = "pending" | "live" | "done" | "missed";

export interface Stage1Mail {
  id: Stage1MailId;
  landedAt: number;
  /** The nominal deadline shown on screen. The server keeps accepting for the grace period. */
  dueAt: number;
  status: Stage1MailStatus;
}

/** The mock's `s1Init`, run when the briefing is closed. */
export const startStage1 = (now: number): Stage1State => ({
  stageStartedAt: now,
  round: 1,
  roundStartedAt: now,
  r3Try: 0,
  doneIds: [],
  curt: [],
  pasted: [],
  memoReplied: false,
  status: { phase: "playing" },
});

const mailStatus = (
  state: Stage1State,
  id: Stage1MailId,
  timing: { landedAt: number; dueAt: number },
  now: number,
): Stage1MailStatus => {
  if (state.doneIds.includes(id)) return "done";
  if (now < timing.landedAt) return "pending";
  // The mock keeps a mail open while `t <= due`, so it is missed only strictly after.
  return now > timing.dueAt + DEADLINE_GRACE_MS ? "missed" : "live";
};

/** This round's mails with their landing, deadline and status. */
export const stage1Mails = (state: Stage1State, now: number): Stage1Mail[] => {
  return STAGE1_SCHEDULES[state.round].map(({ id, at }) => {
    const landedAt = state.roundStartedAt + secondsToMs(at);
    const timing = { landedAt, dueAt: landedAt + STAGE1_REPLY_LIMIT_MS };
    return { id, ...timing, status: mailStatus(state, id, timing, now) };
  });
};

export const stage1MemoDeadlineAt = (state: Stage1State): number =>
  state.stageStartedAt + STAGE1_REPLY_LIMIT_MS;

/**
 * The handover memo (the mock's `s1MemoLive`). Its clock never stops: it runs on the real time
 * even while a result window is open, and a new round does not bring it back.
 */
export const stage1MemoStatus = (
  state: Stage1State,
  now: number,
): Exclude<Stage1MailStatus, "pending"> => {
  if (state.memoReplied) return "done";
  return isPastDeadline(stage1MemoDeadlineAt(state), now) ? "missed" : "live";
};

/** The attempt number shown to the team: R3 counts on as 3, 4, 5 … (the mock's `s1AttemptNo`). */
export const stage1AttemptNo = (state: Stage1State): number =>
  state.round === 3 ? 2 + state.r3Try : state.round;

/** The mock's curt test: shorter than 70 characters, or no polite phrase at all. */
export const isCurtReply = (text: string): boolean =>
  text.length < STAGE1_MIN_REPLY_LENGTH || !POLITE.test(text);

/**
 * The longest run of characters `a` and `b` share (longest common substring), by dynamic
 * programming over one row: O(|a|·|b|) time, O(|b|) memory. A reply is at most 4,000 characters
 * and the memo under 1,000, so this stays within a few million steps.
 */
const longestSharedRun = (a: string, b: string): number => {
  let previous = new Array<number>(b.length + 1).fill(0);
  let longest = 0;
  for (let i = 0; i < a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i] !== b[j - 1]) continue;
      const run = (previous[j - 1] ?? 0) + 1;
      current[j] = run;
      longest = Math.max(longest, run);
    }
    previous = current;
  }
  return longest;
};

/** How many characters in a row the reply shares with the handover memo. */
export const stage1MemoOverlap = (text: string): number => longestSharedRun(text, PASTED_MEMO.text);

/**
 * A reply that copies a long enough run of the handover memo (#44): it is the memo, not an
 * answer to the mail. Checked before `isCurtReply`, so a short scrap of the memo is pasted.
 */
export const isPastedMemoReply = (text: string): boolean =>
  stage1MemoOverlap(text) >= PASTED_MEMO.minRun;

/**
 * Why a reply is refused. Only `empty` is a judgement of the text (「本文が空です」); the others
 * are replies to a mail the screen would not have let the team open.
 */
export const STAGE1_REPLY_REJECT_REASONS = [
  "round-over",
  "not-in-round",
  "not-landed",
  "already-sent",
  "expired",
  "empty",
] as const;

export type Stage1ReplyRejectReason = (typeof STAGE1_REPLY_REJECT_REASONS)[number];

/**
 * Replying clears nothing by itself, so this is deliberately not a `StageJudgement`. `curt` and
 * `pasted` are never both true: a reply that is both counts as pasted.
 */
export type Stage1ReplyJudgement =
  | { outcome: "accepted"; curt: boolean; pasted: boolean }
  | { outcome: "reject"; reason: Stage1ReplyRejectReason };

export interface Stage1ReplyResult {
  state: Stage1State;
  judgement: Stage1ReplyJudgement;
}

/** Why a mail cannot be acted on (replied to, or drafted for) right now. */
type MailBlocker = Exclude<Stage1ReplyRejectReason, "empty">;

const STATUS_REJECT_REASONS: Record<Exclude<Stage1MailStatus, "live">, MailBlocker> = {
  pending: "not-landed",
  done: "already-sent",
  missed: "expired",
};

const mailBlocker = (state: Stage1State, mailId: Stage1MailId, now: number): MailBlocker | null => {
  if (state.status.phase !== "playing") return "round-over";
  const mail = stage1Mails(state, now).find((candidate) => candidate.id === mailId);
  if (mail === undefined) return "not-in-round";
  return mail.status === "live" ? null : STATUS_REJECT_REASONS[mail.status];
};

const reject = (state: Stage1State, reason: Stage1ReplyRejectReason): Stage1ReplyResult => ({
  state,
  judgement: { outcome: "reject", reason },
});

/**
 * The mock's `s1Send`. A curt or pasted reply is sent all the same — the team learns it only
 * when the round ends. The text is judged after trimming, as the mock trims the box.
 */
export const sendStage1Reply = (
  state: Stage1State,
  mailId: Stage1MailId,
  text: string,
  now: number,
): Stage1ReplyResult => {
  const blocker = mailBlocker(state, mailId, now);
  if (blocker !== null) return reject(state, blocker);
  const reply = text.trim();
  if (reply === "") return reject(state, "empty");
  const pasted = isPastedMemoReply(reply);
  const curt = !pasted && isCurtReply(reply);
  return {
    state: {
      ...state,
      doneIds: [...state.doneIds, mailId],
      curt: curt ? [...state.curt, { mailId, reply }] : state.curt,
      pasted: pasted ? [...state.pasted, { mailId, reply }] : state.pasted,
    },
    judgement: { outcome: "accepted", curt, pasted },
  };
};

/**
 * The mock's `s1SendMemo`: only an empty reply is refused. It is not judged, not counted in
 * `doneIds` and never curt or pasted (pasting the memo back to its author is harmless), so it cannot move the round's clear condition. Once a round has
 * ended, the mock's result window covers the whole screen, so nothing can be sent then.
 */
export const sendStage1MemoReply = (
  state: Stage1State,
  text: string,
  now: number,
): Stage1ReplyResult => {
  if (state.status.phase !== "playing") return reject(state, "round-over");
  const status = stage1MemoStatus(state, now);
  if (status !== "live") return reject(state, STATUS_REJECT_REASONS[status]);
  if (text.trim() === "") return reject(state, "empty");
  return {
    state: { ...state, memoReplied: true },
    judgement: { outcome: "accepted", curt: false, pasted: false },
  };
};

const isRoundOver = (state: Stage1State, now: number): boolean => {
  const mails = stage1Mails(state, now);
  const allLanded = mails.every((mail) => mail.status !== "pending");
  const anyLive = mails.some((mail) => mail.status === "live");
  return allLanded && !anyLive;
};

export type Stage1Settlement =
  | { type: "none" }
  | { type: "cleared"; result: (typeof STAGE1_CLEAR_RESULTS)[number] }
  | { type: "round-failed"; failure: (typeof STAGE1_ROUND_FAILURES)[number] };

/**
 * The mock's round-end test in `s1Frame` and `s1RoundComplete`. Call it after every command and
 * whenever the screen asks for the state: it moves the phase once the round is over and does
 * nothing otherwise (so settling twice is harmless, as the mock's guard makes it).
 */
export const settleStage1Round = (
  state: Stage1State,
  now: number,
): { state: Stage1State; settlement: Stage1Settlement } => {
  if (state.status.phase !== "playing" || !isRoundOver(state, now)) {
    return { state, settlement: { type: "none" } };
  }
  if (isCleanRound(state)) {
    const result = state.round === 1 ? "manual" : "ai";
    return {
      state: { ...state, status: { phase: "cleared", result } },
      settlement: { type: "cleared", result },
    };
  }
  const failure = ROUND_FAILURES[state.round];
  return {
    state: { ...state, status: { phase: "round-result", failure } },
    settlement: { type: "round-failed", failure },
  };
};

const newRound = (state: Stage1State, round: Stage1Round, now: number): Stage1State => ({
  ...state,
  round,
  roundStartedAt: now,
  curt: [],
  pasted: [],
  status: { phase: "playing" },
});

/**
 * A new R3 attempt, the first one included. The R3 mails leave `doneIds` (none are there on the
 * first attempt); the memo and the pasted context are left as they are.
 */
const startRound3Attempt = (state: Stage1State, now: number): Stage1State => {
  const round3 = roundMailIds(3);
  return {
    ...newRound(state, 3, now),
    r3Try: state.r3Try + 1,
    doneIds: state.doneIds.filter((id) => !round3.includes(id)),
  };
};

/**
 * The button of a failed round's result window: R1 → R2 (the AI draft button arrives), R2 → R3
 * (苅部さん explains the context box), R3 → the same five mails again (the mock's
 * `s1DeliverAIAndRetry` / `s1StartRound3` / `s1RetryRound3`). `null` when no window is open.
 */
export const acknowledgeStage1RoundResult = (
  state: Stage1State,
  now: number,
): Stage1State | null => {
  if (state.status.phase !== "round-result") return null;
  switch (state.status.failure) {
    case "round1":
      return newRound(state, 2, now);
    case "round2":
    case "round3":
      return startRound3Attempt(state, now);
  }
};

export type Stage1Judgement =
  | (Extract<StageJudgement, { outcome: "pass" }> & {
      result: (typeof STAGE1_CLEAR_RESULTS)[number];
    })
  | (Extract<StageJudgement, { outcome: "reject" }> & { reason: "not-cleared" });

/** Stage 1 is cleared by the round, not by one submission. */
export const judgeStage1 = (state: Stage1State): Stage1Judgement =>
  state.status.phase === "cleared"
    ? { outcome: "pass", result: state.status.result }
    : { outcome: "reject", reason: "not-cleared" };

/** What the result window counts (the mock's `done` / `missed` / `s1.curt.length`, and #44's pasted). */
export interface Stage1RoundSummary {
  total: number;
  done: number;
  missed: number;
  curt: number;
  pasted: number;
}

export const stage1RoundSummary = (state: Stage1State, now: number): Stage1RoundSummary => {
  const mails = stage1Mails(state, now);
  return {
    total: mails.length,
    done: mails.filter((mail) => mail.status === "done").length,
    missed: mails.filter((mail) => mail.status === "missed").length,
    curt: state.curt.length,
    pasted: state.pasted.length,
  };
};

/**
 * What 苅部さん opens with after R1 fails (the mock's `s1DeliverAIAndRetry`): the curt replies
 * when there were at least as many of them as missed mails, the missed mails otherwise. A round
 * failed by pasted replies alone (#44) is `pasted`, for which he has no R1 words.
 */
export const stage1FirstFailureCause = (
  state: Stage1State,
  now: number,
): "curt" | "missed" | "pasted" => {
  const { curt, missed, pasted } = stage1RoundSummary(state, now);
  if (curt === 0 && missed === 0 && pasted > 0) return "pasted";
  return curt >= missed ? "curt" : "missed";
};

export type Stage1DraftJudgement =
  | { outcome: "accepted"; source: "context" | "point" }
  | { outcome: "reject"; reason: MailBlocker | "no-ai" | "no-material" };

/**
 * The gate of [AIに下書きさせる] (the mock's `s1Draft`). The button is in the reply box of an open
 * mail, from R2 on and only while the round runs (a result window covers it), so the mail must
 * be one a reply could go to. Any context wins over the key points; with neither, the AI cannot
 * draft.
 *
 * Changed from the mock in PR #266: the mock's `S1_CTX_MIN` (a context under 100 characters did
 * not count) is gone. A real AI has no minimum, so a thin context simply gives a thin draft.
 */
export const judgeStage1DraftRequest = (
  state: Stage1State,
  mailId: Stage1MailId,
  input: { context: string; point: string },
  now: number,
): Stage1DraftJudgement => {
  const blocker = mailBlocker(state, mailId, now);
  if (blocker !== null) return { outcome: "reject", reason: blocker };
  if (state.round === 1) return { outcome: "reject", reason: "no-ai" };
  if (input.context.trim() !== "") return { outcome: "accepted", source: "context" };
  if (input.point.trim() !== "") return { outcome: "accepted", source: "point" };
  return { outcome: "reject", reason: "no-material" };
};

/** The R3 attempt (`r3Try`) from which 苅部さん speaks up during the round (#222). */
export const STAGE1_ROUND3_HINT_FROM_TRY = 3;

/**
 * Whether 苅部さん should speak up during an R3 attempt (#222, an improvement on the mock): from
 * the third R3 attempt on (`r3Try` 3, shown as attempt 5), while the round runs. It does not look
 * at the context box, and the minute per mail is not loosened.
 *
 * The rule does not say when to ask. The intended wiring (not built yet, SV1 #234 on) is that the
 * screen asks after a reply goes out and shows the hint at most once per attempt, so the same
 * words are not read again and again.
 */
export const shouldHintStage1Round3Retry = (state: Stage1State): boolean =>
  state.status.phase === "playing" &&
  // r3Try is positive only in R3 (an invariant of `stage1StateSchema`), so this is also the round.
  state.r3Try >= STAGE1_ROUND3_HINT_FROM_TRY;

/**
 * When the screen sends `s1.settle` (`GET /game` never judges). A round is over once every mail
 * has landed and none is live, and an unanswered mail is missed only strictly after its deadline
 * plus the grace, so the moment is 1 ms after the last of those. `null` while no round runs (a
 * result window is open, or the stage is cleared). A round whose mails are all answered is
 * settled by its last reply, so its moment (the last landing) is already past.
 */
export const stage1SettleAt = (state: Stage1State): number | null => {
  if (state.status.phase !== "playing") return null;
  const moments = STAGE1_SCHEDULES[state.round].map(({ id, at }) => {
    const landedAt = state.roundStartedAt + secondsToMs(at);
    if (state.doneIds.includes(id)) return landedAt;
    return landedAt + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1;
  });
  return Math.max(...moments);
};
