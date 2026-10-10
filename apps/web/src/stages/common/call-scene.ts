import { portraitSrc, speakerName, type SceneArt } from "../../overlays/clear-sheets.js";

/** An internal call as content gives it: the title bar, the caller's portrait and who it is. */
export interface CallSpeaker {
  readonly tb: string;
  readonly img: string;
  readonly role: string;
  /** The caller's organisation (病院執行部), when content gives one. */
  readonly org?: string;
}

/** What `FullscreenScene` shows of a call: the portrait, the name plate and the title line. */
export interface CallScene {
  readonly art: SceneArt;
  readonly name: string;
  readonly caption: string;
}

/**
 * A scold call over the whole screen (Issue #29), like the clear effect's ② ③: the call's own
 * upright portrait, contained in the middle rather than cropped, with "所属 役職" on the plate and
 * the call's title bar as the line above it.
 */
export const callScene = (call: CallSpeaker): CallScene => ({
  art: { src: portraitSrc(call.img), position: "50% 50%", fit: "contain" },
  name: speakerName({ org: call.org ?? "", role: call.role }),
  caption: call.tb,
});
