import type { LeaderboardSnapshot } from "@hell-ict/domain";
import type { ReactNode } from "react";

import { LeaderboardBar } from "./leaderboard-bar.js";

type ShellProps = {
  vitals: string;
  teamCode: string;
  elapsedSeconds: number;
  leaderboard: LeaderboardSnapshot | null;
  left: ReactNode;
  center: ReactNode;
};

const formatElapsed = (totalSeconds: number): string => {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/**
 * docs/ui/00_共通シェルと通奏低音.md §2の器。3ペインのうち右（AIチャット）は
 * Stage 1のラウンド1では存在しないため、このPRではleft/centerの2ペインだけを持つ。
 * data-mode は呼び出し側のstate.modeがpeace固定の間はpeace以外を渡さない。
 */
export const Shell = ({
  vitals,
  teamCode,
  elapsedSeconds,
  leaderboard,
  left,
  center,
}: ShellProps) => (
  <div className="shell" data-mode="peace">
    <header className="shell__header">
      <p className="shell__hospital">🏥 聖クロノス総合病院 ICT</p>
      <p className="shell__vitals">{vitals}</p>
      <p className="shell__clock" aria-label="経過時間">
        {formatElapsed(elapsedSeconds)}
      </p>
      <p className="shell__team">{teamCode}</p>
    </header>
    <div className="shell__body">
      <aside className="shell__left">{left}</aside>
      <section className="shell__center">{center}</section>
    </div>
    <LeaderboardBar snapshot={leaderboard} />
  </div>
);
