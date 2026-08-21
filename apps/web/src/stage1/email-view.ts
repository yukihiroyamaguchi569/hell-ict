import {
  STAGE1_ROUND1_DEADLINE_MS,
  STAGE1_ROUND1_EMAILS,
  stage1EmailStatus,
} from "@hell-ict/domain";
import type { Stage1Email, Stage1EmailStatus, Stage1Reply } from "@hell-ict/domain";

export interface Stage1EmailView {
  readonly email: Stage1Email;
  readonly status: Stage1EmailStatus;
  readonly remainingMs: number;
}

/** pending（未処理）を先頭群、返信済み・時間切れを後方群にする（docs/ui/02_Stage1.md §1）。 */
const sortRank = (view: Stage1EmailView): number => (view.status === "pending" ? 0 : 1);

/**
 * 左ペインに表示する着弾済みメールの一覧。pendingは締切が近い順に上から並べ、
 * 返信済み・時間切れはその後ろへ回す（docs/ui/02_Stage1.md §1「並び順: 締切が近い順」）。
 * 未着弾のメールは表示しない。
 */
export const stage1EmailViews = (
  roundStartedAt: string,
  replies: readonly Stage1Reply[],
  now: Date,
): Stage1EmailView[] => {
  const roundStart = new Date(roundStartedAt).getTime();
  const nowMs = now.getTime();
  return STAGE1_ROUND1_EMAILS.filter((email) => nowMs >= roundStart + email.arrivalOffsetMs)
    .map((email) => {
      const deadline = roundStart + email.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS;
      return {
        email,
        status: stage1EmailStatus(email, replies, roundStartedAt, now),
        remainingMs: Math.max(0, deadline - nowMs),
      };
    })
    .sort((a, b) => sortRank(a) - sortRank(b) || a.remainingMs - b.remainingMs);
};
