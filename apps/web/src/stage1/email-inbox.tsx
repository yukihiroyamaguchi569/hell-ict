import type { Stage1EmailId } from "@hell-ict/domain";

import type { Stage1EmailView } from "./email-view.js";

type EmailInboxProps = {
  views: readonly Stage1EmailView[];
  selectedEmailId: Stage1EmailId | null;
  onSelect: (emailId: Stage1EmailId) => void;
};

const URGENT_THRESHOLD_MS = 15_000;

const formatRemaining = (ms: number): string => {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const statusLabel = (view: Stage1EmailView): string => {
  if (view.status === "replied") return "返信済み";
  if (view.status === "expired") return "時間切れ・返信不可";
  return formatRemaining(view.remainingMs);
};

/**
 * 左ペイン：10本の砂時計（docs/ui/02_Stage1.md §1）。締切15秒前だけ橙にし、
 * 赤は使わない（急変に取ってある）。時間切れは一覧に残し、消さない。
 */
export const EmailInbox = ({ views, selectedEmailId, onSelect }: EmailInboxProps) => (
  <nav aria-label="受信トレイ">
    <h2>受信トレイ {views.length}</h2>
    <ul>
      {views.map((view) => (
        <li key={view.email.id}>
          <button
            type="button"
            aria-pressed={view.email.id === selectedEmailId}
            disabled={view.status !== "pending"}
            className={
              view.status === "pending" && view.remainingMs <= URGENT_THRESHOLD_MS
                ? "is-urgent"
                : undefined
            }
            onClick={() => {
              onSelect(view.email.id);
            }}
          >
            <span className="email-inbox__from">{view.email.from}</span>
            <span className="email-inbox__subject">{view.email.subject}</span>
            <span className="email-inbox__status">{statusLabel(view)}</span>
          </button>
        </li>
      ))}
    </ul>
  </nav>
);
