import { isStage1Round1Complete, stage1Round1Tally } from "@hell-ict/domain";
import type { Stage1EmailId, Stage1Round1Tally, Stage1State } from "@hell-ict/domain";
import { useMemo, useState } from "react";

import { useTick } from "../shell/use-tick.js";
import { stage1EmailViews } from "./email-view.js";
import type { Stage1EmailView } from "./email-view.js";

export interface UseStage1Round {
  readonly nowMs: number;
  readonly views: readonly Stage1EmailView[];
  readonly selectedView: Stage1EmailView | null;
  readonly selectEmail: (emailId: Stage1EmailId) => void;
  readonly roundComplete: boolean;
  readonly tally: Stage1Round1Tally;
}

/** ラウンド1の表示に必要な計算をまとめる。判定の正はサーバ側の送信結果にあり、ここはUI用の推定に留める。 */
export const useStage1Round = (stage1: Stage1State): UseStage1Round => {
  const nowMs = useTick();
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const [selectedEmailId, setSelectedEmailId] = useState<Stage1EmailId | null>(null);
  const views = useMemo(
    () => stage1EmailViews(stage1.roundStartedAt, stage1.replies, now),
    [stage1.roundStartedAt, stage1.replies, now],
  );
  const selectedView = views.find((view) => view.email.id === selectedEmailId) ?? null;
  return {
    nowMs,
    views,
    selectedView,
    selectEmail: setSelectedEmailId,
    roundComplete: isStage1Round1Complete(stage1.replies, stage1.roundStartedAt, now),
    tally: stage1Round1Tally(stage1.replies),
  };
};
