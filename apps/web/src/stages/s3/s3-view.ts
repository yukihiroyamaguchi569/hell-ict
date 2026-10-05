import {
  stage3FieldLabels,
  stage3KawaiMail,
  stage3LabMail,
  stage3ShichoMail,
  stage3Verdicts,
} from "@hell-ict/content";
import type { Mail, ViewerId } from "@hell-ict/content";
import { stage3FieldIdSchema } from "@hell-ict/domain";
import type { GameCommandResponse, Stage3FieldId, TeamGameViewState } from "@hell-ict/domain";
import { z } from "zod";

import { commandEvents, type SendOutcome } from "../../composables/use-game-session.js";
import type { Verdict } from "../../verdict/verdict.js";
import type { InboxRow } from "../stage-module.js";

/*
 * Stage 3's pure parts: what an answer to `s3.submit` means for the screen, which window the
 * stage layer shows, and the three mails. The trap itself is the server's (the contaminated
 * table and the system prompt): nothing here decides or imitates it.
 */

/** The three mails, each opening its document in the shared viewer (mock renderMails order). */
const viewerRow = (id: string, mail: Mail, doc: ViewerId): InboxRow => ({
  id,
  from: mail.from,
  subject: mail.subj,
  ...(mail.attach === undefined ? {} : { attach: mail.attach }),
  opens: { kind: "viewer", doc },
});

export const stage3InboxRows: readonly InboxRow[] = [
  viewerRow("s3shicho", stage3ShichoMail, "s3patients"),
  viewerRow("s3kawai", stage3KawaiMail, "s3contaminated"),
  viewerRow("s3lab", stage3LabMail, "s3lab"),
];

/** The judge's detail the server sends back (ids only, never the text). */
const judgementSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pass") }),
  z.object({ outcome: z.literal("reject"), field: stage3FieldIdSchema }),
  z.object({ outcome: z.literal("trap") }),
]);

const judgementOf = (response: GameCommandResponse): unknown =>
  response.status === "duplicate" ? response.original.judgement : response.judgement;

/**
 * - none: nothing to say (not answered, refused, or unreadable): the team may press again.
 * - trap-first: the trap fired now; the blackout, the dermatologist and the penalty follow.
 */
export type Stage3Result =
  | { readonly kind: "none" | "pass" | "trap-first" | "trap-repeated" }
  | { readonly kind: "reject"; readonly field: Stage3FieldId };

export const stage3Result = (outcome: SendOutcome): Stage3Result => {
  if (outcome.kind !== "done" || outcome.response.status === "rejected") return { kind: "none" };
  const judgement = judgementSchema.safeParse(judgementOf(outcome.response));
  if (!judgement.success) return { kind: "none" };
  if (judgement.data.outcome === "pass") return { kind: "pass" };
  if (judgement.data.outcome === "reject") return { kind: "reject", field: judgement.data.field };
  const fired = commandEvents(outcome.response).some((event) => event.type === "trap-triggered");
  return { kind: fired ? "trap-first" : "trap-repeated" };
};

/** The rows under the submission (`null`: no verdict box). */
export const stage3Verdict = (result: Stage3Result): Verdict | null => {
  switch (result.kind) {
    case "pass":
      return { kind: "cleared", text: stage3Verdicts.cleared };
    case "reject":
      return {
        kind: "rejected",
        lines: [`${stage3FieldLabels[result.field]}${stage3Verdicts.shortSuffix}`],
      };
    case "trap-repeated":
      return { kind: "rejected", lines: [stage3Verdicts.trapRepeated] };
    default:
      return null;
  }
};

/** How long after entering the stage the director's notice comes: after the red band (mock 2600 ms). */
export const NOTICE_DELAY_MS = 2_600;

/**
 * The window of the stage layer.
 * - notice: the nursing director's news, once (a reload after 了解しました does not bring it
 *   back). Never after the trap: that team has been here already.
 * - blackout, scold: the trap's first firing, played only in the tab that fired it.
 * - penalty: the bottles, as long as the server has the penalty running (a reload lands here),
 *   and a moment longer while 「罰ゲーム完了！」 shows in the tab that paid it (`penaltyHeld`).
 */
export type Stage3Overlay = "notice" | "blackout" | "scold" | "penalty" | null;

export interface OverlayFacts {
  readonly state: TeamGameViewState;
  readonly serverNow: number;
  readonly noticeSeen: boolean;
  /** The trap's scenes this tab is playing (`null`: none). */
  readonly trapScene: "blackout" | "scold" | null;
  /** A submission is on its way: its answer decides what comes next. */
  readonly submitting: boolean;
  /** The penalty was just paid here: its window stays for PENALTY_DONE_MS. */
  readonly penaltyHeld: boolean;
}

const noticeDue = ({ state, serverNow, noticeSeen }: OverlayFacts): boolean => {
  const entered = state.enteredAt.s3;
  return (
    !noticeSeen &&
    state.game.penalties.s3 === "none" &&
    entered !== undefined &&
    serverNow >= Date.parse(entered) + NOTICE_DELAY_MS
  );
};

export const stage3Overlay = (facts: OverlayFacts): Stage3Overlay => {
  if (facts.state.game.stage !== "s3" || facts.submitting) return null;
  if (facts.state.game.penalties.s3 === "in-progress") return facts.trapScene ?? "penalty";
  if (facts.penaltyHeld) return "penalty";
  return noticeDue(facts) ? "notice" : null;
};
