import {
  stage4ActionRejects,
  stage4DirectorMail,
  stage4Labels,
  stage4SendFailed,
  stage4SummaryReject,
} from "@hell-ict/content";
import { STAGE4_ACTION_REJECT_REASONS } from "@hell-ict/domain";
import { z } from "zod";

import type { Verdict } from "../../verdict/verdict.js";
import type { SubmitResult } from "../common/submit-result.js";
import type { InboxRow } from "../stage-module.js";

/** The director's office forwards the report; pressing the row opens it in the viewer. */
export const STAGE4_ROWS: readonly InboxRow[] = [
  {
    id: "s4-director",
    from: stage4DirectorMail.from,
    subject: stage4DirectorMail.subj,
    attach: stage4DirectorMail.attach,
    opens: { kind: "viewer", doc: "s4report" },
  },
];

/*
 * Stage 4's pure part: what the director answers to a sent summary or action, and what the
 * verdict box under it shows. The judging itself is the server's (domain `judgeStage4Summary` /
 * `judgeStage4Action`); the screen only reads the judgement back.
 */

/** The director's window turns to the next page only after this long (mock S4_DIRECTOR_PAGE_GRACE_MS). */
export const DIRECTOR_PAGE_GRACE_MS = 400;

/** The director's window comes up after the red band has gone (mock renderStage4 `later(…, 2600)`). */
export const DIRECTOR_DELAY_MS = 2_600;

/** The talk with the director comes under the summary after it was sent (mock `later(…, 700)`). */
export const TALK_DELAY_MS = 700;

const summaryRejectSchema = z.object({
  outcome: z.literal("reject"),
  reason: z.literal("no-ocular-symptom"),
});

const actionRejectSchema = z.object({
  outcome: z.literal("reject"),
  reason: z.enum(STAGE4_ACTION_REJECT_REASONS),
});

/** The director's words for a summary sent back, or `null` when the judgement is not one. */
export const summarySentBackLine = (judgement: unknown): string | null =>
  summaryRejectSchema.safeParse(judgement).success ? stage4SummaryReject : null;

/** The director's words for an action sent back, by what it lacks (#220). */
export const actionSentBackLine = (judgement: unknown): string | null => {
  const parsed = actionRejectSchema.safeParse(judgement);
  return parsed.success ? stage4ActionRejects[parsed.data.reason] : null;
};

/**
 * The verdict box under a submission, or `null` for none. `acceptedText` is the line once it
 * went through (the summary's 「院長へ送信しました。」), `null` when passing shows nothing here
 * (the action: the clear takes over the screen).
 */
export const submitVerdict = (
  sending: boolean,
  result: SubmitResult | null,
  acceptedText: string | null,
): Verdict | null => {
  if (sending) return { kind: "checking" };
  if (acceptedText !== null) return { kind: "cleared", text: acceptedText };
  if (result?.kind === "sent-back") return { kind: "rejected", lines: [result.line] };
  if (result?.kind === "retry") return { kind: "rejected", lines: [stage4SendFailed] };
  return null;
};

/** The summary's accepted line, while the server has it accepted. */
export const summaryAcceptedText = (accepted: boolean): string | null =>
  accepted ? stage4Labels.summarySent : null;

/** What the team keeps of Stage 4 in sessionStorage (`hellVueS4:<code>`). */
export const stage4RecordSchema = z
  .object({
    /** The team's entry into Stage 4 (`state.enteredAt.s4`): another game's record is not this one's. */
    enteredAt: z.string(),
    summary: z.string(),
    /** The director's window has been read to the end (a reload does not show it again). */
    directorClosed: z.boolean(),
  })
  .strict();

export type Stage4Record = z.infer<typeof stage4RecordSchema>;
