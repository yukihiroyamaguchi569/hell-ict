import { STAGE1_ROUND1_EMAILS } from "@hell-ict/domain";
import type { Stage1Round1Tally } from "@hell-ict/domain";

// docs/scenario/02_Stage1_平常運転.md §処理結果のウィンドウ。相手は参加者を責めない。
const CURT_VOICES = [
  "……以上、でしょうか。",
  "え、これだけ……？",
  "あ、はい。ありがとうございます……。",
  "承知しました。……はい。",
  "お忙しいですよね。こちらこそすみません。",
];
const MAX_VOICES = 4;

type ResultWindowProps = { tally: Stage1Round1Tally };

/**
 * ラウンド1終了後の処理結果ウィンドウ。事務長の窓と同じ2003年書式で表示する
 * （中身の演出はCSSで担い、ここでは構造とテキストだけを組み立てる）。
 */
export const ResultWindow = ({ tally }: ResultWindowProps) => {
  const total = STAGE1_ROUND1_EMAILS.length;
  const missed = total - tally.repliedCount;
  const voices = CURT_VOICES.slice(0, Math.min(MAX_VOICES, tally.curtCount));
  const moreCount = Math.max(0, tally.curtCount - voices.length);
  return (
    <div className="result-window" role="status">
      <p>1回目、終了</p>
      <p>
        {tally.repliedCount} / {total}件しか返せませんでした。手だけでは間に合いません。
      </p>
      {missed > 0 && <p>{missed}件、返信が来ていないと苦情が来ています。</p>}
      {voices.length > 0 && (
        <ul>
          {voices.map((voice) => (
            <li key={voice}>{voice}</li>
          ))}
          {moreCount > 0 && <li>ほか{moreCount}件</li>}
        </ul>
      )}
    </div>
  );
};
