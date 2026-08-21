import type { LeaderboardSnapshot, Stage1EmailId, TeamState } from "@hell-ict/domain";

import { Shell } from "../shell/shell.js";
import { EmailInbox } from "./email-inbox.js";
import { ReplyForm } from "./reply-form.js";
import { ResultWindow } from "./result-window.js";
import { useStage1Round } from "./use-stage1-round.js";

type Stage1TeamState = Extract<TeamState, { stage: "stage1" }>;

type Stage1ScreenProps = {
  state: Stage1TeamState;
  teamCode: string;
  leaderboard: LeaderboardSnapshot | null;
  onSubmitReply: (emailId: Stage1EmailId, text: string) => Promise<void>;
};

const vitalsLine = (metrics: Stage1TeamState["metrics"]): string =>
  `在院 ${String(metrics.occupancy)}/${String(metrics.capacity)}・空床 ${String(metrics.availableBeds)}・原因不明の発熱 ${String(metrics.unknownFever)}`;

/**
 * Stage 1・ラウンド1の画面。右のAIチャットペインはこのラウンドには存在しない
 * （docs/ui/02_Stage1.md §狙い）ため、Shellのleft/centerだけを埋める。
 */
export const Stage1Screen = ({
  state,
  teamCode,
  leaderboard,
  onSubmitReply,
}: Stage1ScreenProps) => {
  const round = useStage1Round(state.stage1);
  // 経過時間はラウンド1のroundStartedAtを暫定的な起点として使う。ラウンド2以降で
  // roundStartedAtがリセットされる時点で、セッション全体用の別のタイムスタンプへ分離する
  // 必要がある（docs/ui/00_共通シェルと通奏低音.md §2 実装メモ）。このPRの既知の簡略化。
  const elapsedSeconds = (round.nowMs - new Date(state.stage1.roundStartedAt).getTime()) / 1000;

  return (
    <Shell
      vitals={vitalsLine(state.metrics)}
      teamCode={teamCode}
      elapsedSeconds={elapsedSeconds}
      leaderboard={leaderboard}
      left={
        <EmailInbox
          views={round.views}
          selectedEmailId={round.selectedView?.email.id ?? null}
          onSelect={round.selectEmail}
        />
      }
      center={
        round.roundComplete ? (
          <ResultWindow tally={round.tally} />
        ) : (
          <ReplyForm view={round.selectedView} onSubmit={onSubmitReply} />
        )
      }
    />
  );
};
