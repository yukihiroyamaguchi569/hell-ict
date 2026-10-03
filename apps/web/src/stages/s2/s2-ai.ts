import {
  stage2Columns,
  stage2KarubeLines,
  stage2PasteErrors,
  stage2PasteNoDelimiter,
  stage2ScriptedLead,
} from "@hell-ict/content";
import { isStage2AddendumLanded, isStage2AiUnlocked, stage2ScriptedTable } from "@hell-ict/domain";
import type { Stage2State, Stage2TableError } from "@hell-ict/domain";

import type { RightPane } from "../../shell/shell-view.js";
import type { KarubeCall } from "../stage-module.js";
import { stage2AddendumGridRows, stage2SheetGridRows } from "./s2-view.js";

/*
 * Stage 2's AI (mock S2_KARUBE_DELAY, phsAIPending, revealAI, s2ScriptedTable, parseTable's
 * errors). Pure: use-stage2 and index.ts only wire these to the clock and 苅部さん's phone.
 */

/** 苅部さん's call of this start of the stage: a team reset by the game master hears it again. */
export const stage2AiCallId = (state: Stage2State): string => `s2-ai:${String(state.startedAt)}`;

/** He rings 45 s into the stage (mock `later(..., S2_KARUBE_DELAY)`), unless it is cleared. */
export const stage2KarubeCalls = (
  state: Stage2State | null,
  nowMs: number,
  cleared: boolean,
): readonly KarubeCall[] =>
  state === null || cleared || !isStage2AiUnlocked(state, nowMs)
    ? []
    : [{ callId: stage2AiCallId(state), lines: stage2KarubeLines }];

/**
 * The right pane: shown once his call has been opened (user decision 10: 45 s and opened; a
 * reload with both comes up with it shown). `null` leaves it to the frame (folded away until
 * then, shown after the clear).
 */
export const stage2RightPane = (
  state: Stage2State | null,
  nowMs: number,
  read: ReadonlySet<string>,
): RightPane | null =>
  state !== null && isStage2AiUnlocked(state, nowMs) && read.has(stage2AiCallId(state))
    ? "shown"
    : null;

/**
 * The scripted answer: whatever was asked, the model answer as a tab-separated table under the
 * lead. The addendum is in it once it has landed (landed, not taken: the row count's basis).
 */
export const stage2ScriptedAnswer = (
  state: Stage2State | null,
  nowMs: number,
): { readonly text: string; readonly table: string } => {
  const landed = state !== null && isStage2AddendumLanded(state, nowMs);
  const table = stage2ScriptedTable(stage2SheetGridRows(), stage2AddendumGridRows(), landed);
  return { text: `${stage2ScriptedLead}\n${table}`, table };
};

/** Why a pasted or sent table did not go into the grid (mock showPasteError). */
export const stage2PasteErrorText = (error: Stage2TableError): string => {
  if (error.reason === "unclosed-quote") return stage2PasteErrors.unclosedQuote;
  if (error.reason === "too-many-columns") {
    return stage2PasteErrors.tooManyColumns(stage2Columns.length, error.row);
  }
  return stage2PasteNoDelimiter;
};
