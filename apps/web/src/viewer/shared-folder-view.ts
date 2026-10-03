import { viewerDocs, type ViewerId } from "@hell-ict/content";
import type { GameStageId } from "@hell-ict/domain";

/*
 * The shared folder under the inbox (mock .docs, go()). The folder itself is always there once the
 * left pane is out; what lies in it depends on the stage only. No unread badge and no notice: it
 * must stay quieter than the inbox.
 */

/** Shown while nothing lies in the folder (mock #docs-empty). */
export const SHARED_FOLDER_EMPTY_TEXT = "（何もありません）";

export interface SharedFolderItem {
  readonly id: ViewerId;
  readonly label: string;
}

/**
 * Each stage's folder holds only what that stage uses, so a stuck team cannot paste another
 * stage's material into the AI (issue #225: at the 2026-09-26 run, two of six teams pasted the
 * Stage 1 memo in Stage 3 and Stage 4).
 */

/**
 * Stages 1 and 2: the handover memo. The inbox's copy vanishes after 60 seconds, but the
 * material itself was on the shelf from the start.
 */
const MEMO_ONLY: readonly ViewerId[] = ["s1memo"];

/**
 * Stage 3 (Kawai's mail has landed): the quick reference and the manual, no memo. The
 * contaminated quick reference comes first: a team in a hurry that grabs from the top picks the
 * wrong one, as Kawai did.
 */
const STAGE3_DOCS: readonly ViewerId[] = ["s3contaminated", "s3manual"];

/** From Stage 4 on, none of the folder's documents belong to the stage: it stays empty. */
const NONE: readonly ViewerId[] = [];

const FOLDER_BY_STAGE: Readonly<Record<GameStageId, readonly ViewerId[]>> = {
  prologue: NONE,
  s1: MEMO_ONLY,
  s2: MEMO_ONLY,
  s3: STAGE3_DOCS,
  s4: NONE,
  s5: NONE,
  s6: NONE,
  final: NONE,
};

/** The documents in the folder at `stage`, top to bottom. */
export const sharedFolderItems = (stage: GameStageId): readonly SharedFolderItem[] =>
  FOLDER_BY_STAGE[stage].map((id) => ({ id, label: `📄 ${viewerDocs[id].name}` }));
