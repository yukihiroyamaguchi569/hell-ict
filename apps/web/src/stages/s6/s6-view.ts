import {
  stage6GenerateMs,
  stage6JimuMail,
  stage6KarubeDelayMs,
  stage6KarubeLine,
  stage6Labels,
  stage6PosterDefault,
  stage6Posters,
  stage6RejectType,
  stage6RequirementRejects,
  stage6SendFailed,
  stage6SoudanMail,
} from "@hell-ict/content";
import type { Mail, ViewerId } from "@hell-ict/content";
import { CHAT_MESSAGE_MAX_CHARS, S6_POSTER_TYPES } from "@hell-ict/domain";
import type { S6PosterType, TeamGameViewState } from "@hell-ict/domain";
import { z } from "zod";

import type { ChatReply, ChatReplyImage, ScriptedTurn } from "../../chat/pane-items.js";
import type { SendOutcome } from "../../composables/use-game-session.js";
import { portraitSrc } from "../../overlays/clear-sheets.js";
import type { Verdict } from "../../verdict/verdict.js";
import { judgementOf, submitResult, type SubmitResult } from "../common/submit-result.js";
import type { InboxRow, KarubeCall } from "../stage-module.js";

/*
 * Stage 6's pure part: the conversation drawn from the server's prompt log and candidates (user
 * decision 8), the candidate picked for submission, what the submission's answer says, and
 * 苅部さん's one call. The poster type and the judging are the server's (domain s6.ts).
 */

const viewerRow = (id: string, mail: Mail, doc: ViewerId): InboxRow => ({
  id,
  from: mail.from,
  subject: mail.subj,
  ...(mail.attach === undefined ? {} : { attach: mail.attach }),
  opens: { kind: "viewer", doc },
});

/** 近藤さん's mail (with last year's notice) above 事務長's, as the mock lists them. */
export const STAGE6_ROWS: readonly InboxRow[] = [
  viewerRow("s6soudan", stage6SoudanMail, "s6notice"),
  viewerRow("s6jimu", stage6JimuMail, "s6jimu"),
];

type Stage6Shape = TeamGameViewState["s6"];

/** The pre-generated picture of a candidate type. */
export const posterImage = (type: S6PosterType): ChatReplyImage => {
  const poster = stage6Posters.find((candidate) => candidate.type === type) ?? stage6PosterDefault;
  return { src: portraitSrc(poster.img), alt: poster.alt };
};

/** A message the screen answers itself: a copy sent back, a generation that was lost. */
export interface Stage6Note {
  /** Negative, so it never meets a candidate's index. */
  readonly id: number;
  readonly text: string;
  readonly reply: ChatReply | null;
  /** Stands after this many of the other turns (where it was said). */
  readonly after: number;
}

/**
 * What the screen holds besides the server's state. `hideFrom`: the candidates from this index on
 * are still behind a 「画像を生成しています…」 (the 2.5 s wait, user decision 10), `null` for none.
 * `generating`: those waits, each with the candidate index it is expected to become as its id.
 */
export interface Stage6Local {
  readonly hideFrom: number | null;
  readonly generating: readonly Pick<ScriptedTurn, "id" | "text">[];
  readonly notes: readonly Stage6Note[];
}

const candidateTurn = (
  text: string,
  type: S6PosterType,
  index: number,
  pick: (index: number) => void,
): ScriptedTurn => ({
  id: index,
  text,
  reply: {
    text: "",
    image: posterImage(type),
    action: {
      label: stage6Labels.pick,
      run: () => {
        pick(index);
      },
    },
  },
});

/**
 * The conversation: each instruction in the prompt log with the poster it made (the turn's id is
 * the candidate's index, the same across reloads), then the generations still waiting, with the
 * notes where they were said. A copy of the mails never enters the log, so it is only a note.
 */
export const stage6Turns = (
  s6: Stage6Shape,
  local: Stage6Local,
  pick: (index: number) => void,
): readonly ScriptedTurn[] => {
  const shown = s6.candidates.slice(0, local.hideFrom ?? s6.candidates.length);
  const ordered: ScriptedTurn[] = [
    ...shown.map((type, index) => candidateTurn(s6.promptLog[index] ?? "", type, index, pick)),
    ...local.generating.map(({ id, text }) => ({
      id,
      text,
      reply: null,
      waitingText: stage6Labels.generating,
      waitingMs: stage6GenerateMs,
    })),
  ];
  const notesAt = (position: number): ScriptedTurn[] =>
    local.notes
      .filter((note) => Math.min(note.after, ordered.length) === position)
      .map(({ id, text, reply }) => ({ id, text, reply }));
  return [
    ...ordered.flatMap((turn, position) => [...notesAt(position), turn]),
    ...notesAt(ordered.length),
  ];
};

/**
 * Where an instruction whose answer was lost landed in the log read again, or `null`: the first
 * entry logged since it was sent (`from`) with its text that no other generation of this screen
 * has claimed. This screen's sends are applied in the order they leave, so an earlier send of the
 * same text owns the earlier entry.
 */
export const lostPromptIndex = (
  promptLog: readonly string[],
  text: string,
  from: number,
  claimed: ReadonlySet<number>,
): number | null => {
  for (let index = from; index < promptLog.length; index++) {
    if (promptLog[index] === text && !claimed.has(index)) return index;
  }
  return null;
};

/** What the team keeps of its pick in sessionStorage (`hellVueS6Pick:<code>`, user decision 9). */
export const stage6PickSchema = z
  .object({ enteredAt: z.string(), index: z.number().int().nonnegative() })
  .strict();

export type Stage6Pick = z.infer<typeof stage6PickSchema>;

/**
 * How many generations may wait for their answer at once (a new one is not sent past it), and how
 * many whose answer is lost are kept (the oldest go first). The record holds at most both.
 */
export const UNSETTLED_MAX = 5;

/** `sends` with the oldest of those whose answer is lost cut down to UNSETTLED_MAX. */
export const keptUnsettled = <T extends { readonly lost: boolean }>(
  sends: readonly T[],
): readonly T[] => {
  let drop = sends.filter((send) => send.lost).length - UNSETTLED_MAX;
  return sends.filter((send) => !send.lost || drop-- <= 0);
};

const unsettledSendSchema = z
  .object({
    text: z.string().max(CHAT_MESSAGE_MAX_CHARS),
    commandId: z.string(),
    /** The length of the prompt log when it was first sent: it can only have landed after. */
    sentAtCount: z.number().int().nonnegative(),
  })
  .strict();

export type UnsettledSend = z.infer<typeof unsettledSendSchema>;

/**
 * The generations not known to have arrived (`hellVueS6Generate:<code>`): sending the same text
 * again reuses its commandId, so one the server applied comes back `duplicate` instead of a second
 * poster. A text with personal data is never kept here (memory only).
 */
export const stage6UnsettledSchema = z
  .object({
    enteredAt: z.string(),
    entries: z.array(unsettledSendSchema).max(UNSETTLED_MAX * 2),
  })
  .strict();

/**
 * The unsettled sends the prompt log shows applied, with where each landed. In the order they
 * were sent, each takes the first entry of its text (as the server keeps it: `shown`) logged since
 * it was sent that nothing else has taken.
 */
export const appliedSends = <T extends { readonly shown: string; readonly sentAtCount: number }>(
  promptLog: readonly string[],
  sends: readonly T[],
  claimed: ReadonlySet<number>,
): readonly (readonly [T, number])[] => {
  const taken = new Set(claimed);
  return sends.flatMap((send) => {
    const index = lostPromptIndex(promptLog, send.shown, send.sentAtCount, taken);
    if (index === null) return [];
    taken.add(index);
    return [[send, index] as const];
  });
};

/** 事務長's call has been closed in this stay (`hellVueS6Task:<code>`). */
export const stage6TaskSchema = z.object({ enteredAt: z.string() }).strict();

export interface Stage6Selected {
  readonly index: number;
  readonly image: ChatReplyImage;
}

/** The candidate in the submission box, or `null`: none picked, another stay's, or not there. */
export const stage6Selected = (
  s6: Stage6Shape,
  enteredAt: string | null,
  pick: Stage6Pick | null,
): Stage6Selected | null => {
  if (pick === null || pick.enteredAt !== enteredAt) return null;
  const type = s6.candidates[pick.index];
  return type === undefined ? null : { index: pick.index, image: posterImage(type) };
};

const generatedSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(S6_POSTER_TYPES),
});

/**
 * What an `s6.generate` came to:
 * - made: the candidate `index` is in the state that came back.
 * - copied: the server found a copy of the mails (nothing was logged).
 * - lost: not known to have arrived; the screen asks for the state again.
 * - none: refused for another reason (a stale tab, the stage moved on): nothing to say.
 */
export type Stage6GenerateResult =
  | { readonly kind: "made"; readonly index: number }
  | { readonly kind: "copied" | "lost" | "none" };

export const stage6GenerateResult = (outcome: SendOutcome): Stage6GenerateResult => {
  if (outcome.kind === "unavailable" || outcome.kind === "failed") return { kind: "lost" };
  if (outcome.kind !== "done") return { kind: "none" };
  const { response } = outcome;
  if (response.status === "rejected") {
    return { kind: response.reason === "copied-from-mail" ? "copied" : "none" };
  }
  const made = generatedSchema.safeParse(judgementOf(response));
  return made.success ? { kind: "made", index: made.data.index } : { kind: "lost" };
};

const submitRejectSchema = z.object({
  outcome: z.literal("reject"),
  reason: z.enum(["textheavy", "default", "mask", "visiting-hours"]),
});

/** 近藤さん's words for a submission sent back, by the first thing it lacks. */
const sentBackLine = (judgement: unknown): string | null => {
  const parsed = submitRejectSchema.safeParse(judgement);
  if (!parsed.success) return null;
  const { reason } = parsed.data;
  if (reason === "mask") return stage6RequirementRejects.mask;
  if (reason === "visiting-hours") return stage6RequirementRejects.visitingHours;
  return stage6RejectType[reason];
};

/** 近藤さん sends a submission back with his line (no penalty, no limit). */
export const stage6SubmitResult = (outcome: SendOutcome): SubmitResult =>
  submitResult(outcome, sentBackLine);

/** The verdict box under the submission, or `null` for none. */
export const stage6Verdict = (
  sending: boolean,
  result: SubmitResult | null,
  cleared: boolean,
): Verdict | null => {
  if (sending) return { kind: "checking" };
  if (cleared) return { kind: "cleared", text: stage6Labels.cleared };
  if (result?.kind === "sent-back") return { kind: "rejected", lines: [result.line] };
  if (result?.kind === "retry") return { kind: "rejected", lines: [stage6SendFailed] };
  return null;
};

/** 苅部さん's call of this stay: a team reset by the game master hears it again. */
export const stage6KarubeCallId = (enteredAt: string): string => `s6:${enteredAt}`;

/** He rings once, 40 s into the stage (mock S6_KARUBE_DELAY), unless it is cleared. */
export const stage6KarubeCalls = (
  enteredAt: string | null,
  nowMs: number,
  cleared: boolean,
): readonly KarubeCall[] =>
  enteredAt === null || cleared || nowMs < Date.parse(enteredAt) + stage6KarubeDelayMs
    ? []
    : [{ callId: stage6KarubeCallId(enteredAt), lines: [stage6KarubeLine] }];
