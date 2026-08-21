import type { LeaderboardEntry, LeaderboardSnapshot, Stage } from "@hell-ict/domain";

// docs/ui/00_共通シェルと通奏低音.md §5 の停留所ラベル。全ステージ実装が進むごとに増やす。
const STAGE_STOPS: readonly { readonly stage: Stage; readonly label: string }[] = [
  { stage: "prologue", label: "Prologue" },
  { stage: "stage1", label: "S1" },
];
const STAGE_ORDER: Readonly<Record<Stage, number>> = { prologue: 0, stage1: 1 };

type LeaderboardBarProps = { snapshot: LeaderboardSnapshot | null };

const leaderRank = (entries: readonly LeaderboardEntry[]): number =>
  entries.reduce((max, entry) => Math.max(max, STAGE_ORDER[entry.stage]), 0);

/**
 * 自陣は◆＋チーム名、首位は●＋チーム名、その他は○のみ（企画書§9「下位チームを名指しで晒さない」）。
 * 自陣が首位を兼ねる場合は◆を優先する。
 */
const markerLabel = (entry: LeaderboardEntry, rank: number): string => {
  if (entry.isSelf) return `◆${entry.marker}`;
  if (STAGE_ORDER[entry.stage] === rank) return `●${entry.marker}`;
  return "○";
};

export const LeaderboardBar = ({ snapshot }: LeaderboardBarProps) => {
  const entries = snapshot?.entries ?? [];
  const rank = leaderRank(entries);
  return (
    <footer className="leaderboard-bar" aria-label="リーダーボード">
      <ol className="leaderboard-bar__stops">
        {STAGE_STOPS.map((stop) => (
          <li key={stop.stage}>{stop.label}</li>
        ))}
      </ol>
      <ol className="leaderboard-bar__markers">
        {entries.map((entry) => (
          <li key={entry.marker} className={entry.isSelf ? "is-self" : undefined}>
            {markerLabel(entry, rank)}
          </li>
        ))}
      </ol>
    </footer>
  );
};
