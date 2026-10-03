import { handoverNotes, stage1ClearAdminLines, stageClears } from "@hell-ict/content";
import type { FullscreenArt } from "@hell-ict/content";
import type { GameStageId, PlayedStageId, TeamGameViewState } from "@hell-ict/domain";

import type { SfxName } from "../composables/use-sfx.js";

/*
 * What the four sheets of a stage's clear show (mock `startClearPopups`): ① the notice, ② the
 * ward's reaction, ③ the executive's words (each a full-screen picture with subtitles) and, after
 * Stage 2 and 4, ④ the request to change who operates the PC. Pure: ClearSequence.vue only draws
 * what this returns.
 */

/** The picture laid over the whole screen behind the subtitles of ② or ③. */
export interface ClearArt {
  /** `/assets/images/production/<file>` (the Worker serves the production art). */
  readonly src: string;
  /** The CSS object-position: where the picture is anchored when the screen crops it. */
  readonly position: string;
}

/** One sheet of ② or ③: a full-screen picture, the speaker's name plate and the lines. */
export interface ClearCard {
  readonly art: ClearArt;
  /** The name plate: "所属 役職", or the role alone when there is no 所属. Also the picture's alt. */
  readonly name: string;
  readonly lines: readonly string[];
}

export interface ClearSheets {
  readonly title: string;
  /** Empty for Stage 1, which has no subtitle. */
  readonly sub: string;
  /** Played once, on ①. `null` for Stage 1: its result window has already played one. */
  readonly sfx: SfxName | null;
  readonly field: ClearCard;
  readonly exec: ClearCard;
  /** The lines of ④, or `null` when the team is not asked to change seats after this stage. */
  readonly handover: readonly string[] | null;
}

export const portraitSrc = (file: string): string => `/assets/images/production/${file}`;

/**
 * Where a full-screen picture is anchored when content does not say: the faces sit in the upper
 * half of every picture, so a crop keeps the top and gives up the dark bottom first.
 */
export const DEFAULT_ART_POSITION = "50% 20%";

const art = (fullscreen: FullscreenArt): ClearArt => ({
  src: portraitSrc(fullscreen.img),
  position: fullscreen.position ?? DEFAULT_ART_POSITION,
});

const speakerName = (who: { readonly org: string; readonly role: string }): string =>
  who.org === "" ? who.role : `${who.org} ${who.role}`;

/**
 * How the team cleared Stage 1: by hand in round 1 or with the AI after. The director's verdict
 * that opens ③ depends on it (mock `s1AdminLine`). `null` when the state does not say (it
 * always does once Stage 1 is cleared).
 */
export const stage1ClearResult = (state: TeamGameViewState): "manual" | "ai" | null =>
  state.s1?.status.phase === "cleared" ? state.s1.status.result : null;

const execLines = (stage: PlayedStageId, s1Result: "manual" | "ai" | null): readonly string[] => {
  const lines = stageClears[stage].exec;
  if (stage !== "s1" || s1Result === null) return lines;
  return [stage1ClearAdminLines[s1Result], ...lines];
};

const handoverLines = (stage: PlayedStageId): readonly string[] | null =>
  stage === "s2" || stage === "s4" ? handoverNotes[stage] : null;

export const clearSheets = (
  stage: PlayedStageId,
  s1Result: "manual" | "ai" | null,
): ClearSheets => {
  const clear = stageClears[stage];
  return {
    title: clear.title,
    sub: clear.sub,
    sfx: clear.sfx === "" ? null : clear.sfx,
    field: {
      art: art(clear.field.fullscreen),
      name: speakerName(clear.field),
      lines: clear.field.lines,
    },
    exec: {
      art: art(clear.execFullscreen),
      name: speakerName(clear.voice),
      lines: execLines(stage, s1Result),
    },
    handover: handoverLines(stage),
  };
};

/**
 * The full-screen pictures of ② and ③ of `stage`'s clear, to fetch while the stage is played
 * (Issue #378, #371): nothing else shows them, so otherwise they are first asked for the moment ②
 * opens. Only this stage's two, not all twelve. Empty for the Prologue and Final, which have no
 * clear effect. Stage 1's ③ is the same picture whichever way it was cleared (only the lines
 * change).
 */
export const clearPortraitSrcs = (stage: GameStageId): readonly string[] => {
  if (stage === "prologue" || stage === "final") return [];
  const { field, exec } = clearSheets(stage, null);
  return [field.art.src, exec.art.src];
};
