/**
 * Stage 6 (the visiting-restriction poster) judges, ported from the mock
 * (hell-ict-archive:docs/ui/mock/index.html: S6_POSTERS, s6IsCopiedFromMail, s6Generate's candidate choice,
 * checkStage6 with the #218 fix). Reject only: no trap, no penalty, no limit on retries
 * or on the number of generations.
 *
 * The prompt log (every instruction sent to the AI in this stage) is held by the caller's
 * state and passed in; nothing here stores it.
 */
import { posterTypes, stage6JimuMail, stage6Rules, stage6SoudanMail } from "@hell-ict/content";

import type { StageJudgement } from "../schemas/game.js";

/** The candidate kinds (content's `posterTypes`, the `type` of `stage6Posters`). */
export const S6_POSTER_TYPES = posterTypes;

export type S6PosterType = (typeof S6_POSTER_TYPES)[number];

/**
 * The pre-generated candidates are chosen by these tags in the latest prompt (first match
 * wins). The tag only picks the image; the judge looks at the resulting type.
 */
const POSTER_TAGS: readonly { type: S6PosterType; tag: RegExp }[] = stage6Rules.posterTags;

/**
 * The candidate type for a new generation. A prompt without a tag ("マスクも入れて")
 * keeps the previous candidate's type, as a chat that remembers context would edit the
 * last image; with no previous candidate it is the default poster.
 */
export const selectS6PosterType = (
  prompt: string,
  previousType: S6PosterType | null,
): S6PosterType =>
  POSTER_TAGS.find((poster) => poster.tag.test(prompt))?.type ?? previousType ?? "default";

/**
 * Paragraphs of the two stage mails (事務長 and 患者相談窓口 近藤), taken from content. They
 * already state every requirement, so pasting them would pass without translating the request
 * into an instruction — the one thing this stage teaches.
 */
export const S6_MAIL_PARAGRAPHS = [...stage6JimuMail.body, ...stage6SoudanMail.body] as const;

/**
 * A copy is 32 consecutive characters of a mail paragraph after normalization. Every mail
 * sentence is longer than 40, so a whole sentence is always caught, while quoting a phrase
 * ("面会時間は14時から16時まで" is 18) is not.
 */
const COPY_MIN = 32;

/** Drops whitespace, punctuation and brackets so reflowing or adding a comma does not hide a copy. */
const normalizeForCopy = (text: string): string =>
  text.replace(/[\s、。，．,.・…「」『』（）()【】〔〕]/g, "");

const containsWindowOf = (haystack: string, paragraph: string): boolean => {
  const source = normalizeForCopy(paragraph);
  for (let i = 0; i + COPY_MIN <= source.length; i++) {
    if (haystack.includes(source.slice(i, i + COPY_MIN))) return true;
  }
  return false;
};

/**
 * Whether a prompt is pasted from the mails. Such a prompt is neither generated nor added
 * to the prompt log, and does not count as a generation (the caller's responsibility).
 */
export const isS6PromptCopiedFromMail = (text: string): boolean => {
  const haystack = normalizeForCopy(text);
  if (haystack.length < COPY_MIN) return false;
  return S6_MAIL_PARAGRAPHS.some((paragraph) => containsWindowOf(haystack, paragraph));
};

export type S6RejectReason = "textheavy" | "default" | "mask" | "visiting-hours";

export type S6SubmissionJudgement =
  | { outcome: "pass" }
  | { outcome: "reject"; reason: S6RejectReason };

/**
 * Requirements checked against the whole prompt log, not the selected candidate's prompt
 * alone: teams add requirements one instruction at a time. The words live in content.
 */
const REQUIREMENTS = [
  { reason: "mask", re: stage6Rules.requirements.mask },
  { reason: "visiting-hours", re: stage6Rules.requirements.visitingHours },
] as const satisfies readonly { reason: S6RejectReason; re: RegExp }[];

/**
 * Hiragana to katakana (#218: "ますく" must meet /マスク/). One character maps to one, and
 * the requirements have no hiragana, so the visiting-hours check is unaffected. Used for
 * judging only; logs and display keep the original text.
 */
const hiraganaToKatakana = (text: string): string =>
  text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/**
 * The submission (checkStage6): first the candidate type (textheavy and default are always
 * rejected), then the requirements against the prompt log. The first failure is returned.
 */
export const judgeS6Submission = ((
  candidateType: S6PosterType,
  promptLog: readonly string[],
): S6SubmissionJudgement => {
  if (candidateType === "textheavy" || candidateType === "default") {
    return { outcome: "reject", reason: candidateType };
  }
  const said = hiraganaToKatakana(promptLog.join("\n"));
  const missing = REQUIREMENTS.find((requirement) => !requirement.re.test(said));
  return missing === undefined
    ? { outcome: "pass" }
    : { outcome: "reject", reason: missing.reason };
}) satisfies (candidateType: S6PosterType, promptLog: readonly string[]) => StageJudgement;
