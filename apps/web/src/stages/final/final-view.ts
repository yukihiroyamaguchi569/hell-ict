import {
  FINAL_LINE_MAX,
  finalBoardTiles,
  finalHandover,
  finalLabels,
  finalRelay,
} from "@hell-ict/content";
import { z } from "zod";

import { portraitSrc } from "../../overlays/clear-sheets.js";

// Final's pure part: the order of its scenes, the line the team leaves (nothing is judged: the
// mock's fSubmitLine refuses an empty line only), and the certificate.
/** The tiles light one by one at this interval (mock F_BOARD_LIGHT_MS). */
export const BOARD_LIGHT_MS = 400;
/** After the line is written, the board pulses this long before the relay (mock `later(…, 1100)`). */
export const RELAY_AFTER_LINE_MS = 1_100;
/** Coming back with the line written but the relay not finished (mock `later(…, 700)`). */
export const RELAY_ON_RETURN_MS = 700;
/** Presses on the epilogue this soon after it opens are the goal's ［振り返りへ進む］ clicked twice. */
export const EPILOGUE_GRACE_MS = 400;

export const TILE_COUNT = finalBoardTiles.length;
const LAST_RELAY_STEP = finalRelay.length - 1;

/**
 * Where the team is in Final, in this order:
 * - goal → epilogue: the race is over (shown at Final's entrance until ［振り返りへ］).
 * - board: `lit` tiles are lit; with all lit the piece opens for the line, and the board is
 *   complete once the line is written.
 * - relay: the three voices, `step` 0〜2, over the complete board.
 * - handover: the certificate, the end.
 * - rest: ［最初に戻る］ left the certificate; going on again brings it back.
 */
export type FinalPhase =
  | { readonly kind: "goal" }
  | { readonly kind: "epilogue" }
  | { readonly kind: "board"; readonly lit: number }
  | { readonly kind: "relay"; readonly step: number }
  | { readonly kind: "handover" }
  | { readonly kind: "rest" };

/** `hellVueFinalIntro:<code>`: the goal and the epilogue were read for this entry. */
export const finalIntroRecordSchema = z.object({ enteredAt: z.string() });

/** `hellVueFinal:<code>`: the line and whether the certificate was reached, for this entry. */
export const finalRecordSchema = z
  .object({
    enteredAt: z.string(),
    line: z.string().trim().min(1).max(FINAL_LINE_MAX).nullable(),
    ended: z.boolean(),
    /**
     * The line's `submit.final` not yet known to be kept: a reload sends it again under the same
     * commandId and time (the debriefing reads it). `null` once kept or refused for good. The
     * Worker refuses a commandId that is not a UUID, so such a stored value is dropped here.
     */
    pending: z.object({ commandId: z.uuid(), clientAt: z.iso.datetime() }).nullable(),
  })
  .refine((record) => record.line !== null || (!record.ended && record.pending === null));

export type PendingLine = NonNullable<FinalRecord["pending"]>;

export type FinalRecord = z.infer<typeof finalRecordSchema>;

/** Where a (re)entry starts. The relay after a written line is the composable's timer. */
export const entryPhase = (introDone: boolean, record: FinalRecord | null): FinalPhase => {
  if (record?.ended === true) return { kind: "handover" };
  if (record !== null && record.line !== null) return { kind: "board", lit: TILE_COUNT };
  return introDone ? { kind: "board", lit: 0 } : { kind: "goal" };
};

/** ［振り返りへ進む］ on the goal. */
export const afterGoal = (phase: FinalPhase): FinalPhase =>
  phase.kind === "goal" ? { kind: "epilogue" } : phase;

/** ［振り返りへ］ on the epilogue: the board starts dark. */
export const afterEpilogue = (phase: FinalPhase): FinalPhase =>
  phase.kind === "epilogue" ? { kind: "board", lit: 0 } : phase;

export const lightNextTile = (phase: FinalPhase): FinalPhase =>
  phase.kind === "board" && phase.lit < TILE_COUNT ? { kind: "board", lit: phase.lit + 1 } : phase;

/** The piece takes the line only once every tile is lit and nothing is written yet. */
export const pieceOpen = (phase: FinalPhase, line: string | null): boolean =>
  phase.kind === "board" && phase.lit === TILE_COUNT && line === null;

export type LineCheck =
  | { readonly kind: "ok"; readonly line: string }
  | { readonly kind: "refused"; readonly note: string };

/** Only an empty line is refused (and one past the input's limit); what it says is not judged. */
export const checkLine = (input: string): LineCheck => {
  const line = input.trim();
  if (line === "") return { kind: "refused", note: finalLabels.lineEmpty };
  if (line.length > FINAL_LINE_MAX) return { kind: "refused", note: finalLabels.lineTooLong };
  return { kind: "ok", line };
};

/** The relay starts over the complete board. */
export const startRelay = (phase: FinalPhase, line: string | null): FinalPhase =>
  phase.kind === "board" && phase.lit === TILE_COUNT && line !== null
    ? { kind: "relay", step: 0 }
    : phase;

/** A click on the relay's backdrop hurries to the next voice, but never past the last one. */
export const relayBackdrop = (phase: FinalPhase): FinalPhase =>
  phase.kind === "relay" && phase.step < LAST_RELAY_STEP
    ? { kind: "relay", step: phase.step + 1 }
    : phase;

/** ［次へ］, and on the last voice ［感謝状を受け取る］: the only way to the certificate. */
export const relayNext = (phase: FinalPhase): FinalPhase => {
  if (phase.kind !== "relay") return phase;
  return phase.step < LAST_RELAY_STEP
    ? { kind: "relay", step: phase.step + 1 }
    : { kind: "handover" };
};

export const relayButtonText = (step: number): string =>
  step < LAST_RELAY_STEP ? finalLabels.relayNext : finalLabels.relayLast;

/** ［最初に戻る］ (decision 14 B): the team's record stays; only the certificate is left. */
export const restart = (phase: FinalPhase): FinalPhase =>
  phase.kind === "handover" ? { kind: "rest" } : phase;

/** Going on from the rest brings the certificate back. */
export const resume = (phase: FinalPhase): FinalPhase =>
  phase.kind === "rest" ? { kind: "handover" } : phase;

/** The full-width space between the name and 「ゴール」 or 「御中」 (mock goalSequence, fShowHandover). */
const WIDE_SPACE = "　";

/** The team's name, the first of the goal title's two lines (the second is 「ゴール」). */
export const goalTeamName = (teamName: string): string =>
  teamName.trim() || finalLabels.goalTeamFallback;

/** The goal's title read as one line (its heading's accessible name). */
export const goalTitle = (teamName: string): string =>
  `${goalTeamName(teamName)}${WIDE_SPACE}${finalLabels.goal}`;

export const handoverAddress = (teamName: string): string =>
  `${teamName.trim() || finalHandover.teamFallback}${WIDE_SPACE}${finalHandover.honorific}`;

export const handoverQuote = (line: string | null): string => `「${line ?? ""}」`;

/** The stage behind the goal's title (the picture has no words; the title is laid over it). */
export const GOAL_BACKDROP = portraitSrc("final-goal-ceremony.webp");
/** The certificate's paper and gilded frame; its text is laid inside the plain middle. */
export const CERTIFICATE_FRAME = portraitSrc("final-certificate-frame.webp");

export type QuoteSize = "large" | "medium" | "small";

const QUOTE_LARGE_MAX = 34;
const QUOTE_MEDIUM_MAX = 74;

/**
 * How big the certificate sets the team's line (with its 「」): a short line large, and smaller as
 * it grows, so even a line of FINAL_LINE_MAX stays inside the frame's plain middle.
 */
export const quoteSize = (quote: string): QuoteSize => {
  if (quote.length <= QUOTE_LARGE_MAX) return "large";
  return quote.length <= QUOTE_MEDIUM_MAX ? "medium" : "small";
};

/** The scenes drawn over the whole screen; the board and the rest are the centre pane's. */
export const overlayScene = (phase: FinalPhase): boolean =>
  phase.kind !== "board" && phase.kind !== "rest";

/** How many tiles the board shows lit: dark under the goal, complete from the relay on. */
export const litTiles = (phase: FinalPhase): number => {
  if (phase.kind === "board") return phase.lit;
  return phase.kind === "goal" || phase.kind === "epilogue" ? 0 : TILE_COUNT;
};
