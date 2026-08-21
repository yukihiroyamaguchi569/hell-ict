import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type BriefingOverlayProps = { onAcknowledge: () => void };

// docs/ui/02_Stage1.md §0「タイミング」の BRIEF_BEATS。最後の2拍（通達枠・ボタン）は
// 事務長が話し終えたあとに間を空ける。
const BEAT_TIMES_MS = [0, 400, 1200, 2000, 2800, 3600, 4300, 4700];

// 台詞は docs/scenario/02_Stage1_平常運転.md §0 を正典とする。
// 肖像画像（assets/images/production/stage1-administrative-director.png）の配信経路は
// 企画書§7のR2/CDN方針を実装してから配線する（このPRのスコープ外）。
const BEAT_CONTENT: readonly ReactNode[] = [
  <div className="briefing-overlay__speaker" key="speaker">
    <div className="briefing-overlay__portrait" aria-hidden="true" />
    <p>病院執行部 事務長</p>
  </div>,
  <p key="line1">——ああ、派遣の皆さん。本日からでしたね。ご足労さまです。</p>,
  <p key="line2">
    さっそくですが、まずはメール処理をお願いします。現場から問い合わせが山ほど来ていますので。感染対策は、その後で結構です。
  </p>,
  <p key="line3">
    内容は簡潔で結構です。ただし、先方に失礼のない文面でお願いしますよ。うちは、そういうところを見られますので。
  </p>,
  <p key="line4">あ、ひとつだけ。うちのメールは、返信しないと消えます。</p>,
  <p key="line5">
    <span className="briefing-overlay__warn">他の職員は5分ですが</span>
    ——優秀な皆さんなら、1分もあれば十分でしょう？
  </p>,
  <p key="line6">では、よろしくお願いします。</p>,
  <div className="briefing-overlay__notice" key="notice">
    <p>院内メールシステムのご利用について（総務課）</p>
    <ul>
      <li>受信から60秒を経過したメールは自動的に削除されます。</li>
      <li>削除されたメールへの返信はできません。</li>
      <li>督促および再送は行いません。</li>
      <li>極端に短い返信は、送信後に苦情の対象となる場合があります。</li>
    </ul>
  </div>,
];

/**
 * 事務長ブリーフィング（docs/ui/00_共通シェルと通奏低音.md §7・docs/ui/02_Stage1.md §0）。
 * 段落単位で順に出し、画面のどこを押しても残りが即座に全部出る。ボタンは最後のビートが
 * 出るまで押せない——1行も読まないうちにStage 1が始まってしまうことを防ぐ。
 */
export const BriefingOverlay = ({ onAcknowledge }: BriefingOverlayProps) => {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisibleCount(BEAT_TIMES_MS.length);
      return;
    }
    const timers = BEAT_TIMES_MS.map((delay, index) =>
      window.setTimeout(() => {
        setVisibleCount((count) => Math.max(count, index + 1));
      }, delay),
    );
    return () => {
      timers.forEach((id) => {
        window.clearTimeout(id);
      });
    };
  }, []);

  const revealAll = (): void => {
    setVisibleCount(BEAT_TIMES_MS.length);
  };

  return (
    <div
      className="briefing-overlay"
      role="dialog"
      aria-label="事務長ブリーフィング"
      onClick={revealAll}
    >
      <div className="briefing-overlay__window">
        {BEAT_CONTENT.slice(0, visibleCount).map((content, index) => (
          <div className="briefing-overlay__beat" key={index}>
            {content}
          </div>
        ))}
        {visibleCount >= BEAT_TIMES_MS.length && (
          <button
            type="button"
            className="briefing-overlay__ack"
            onClick={(event) => {
              event.stopPropagation();
              onAcknowledge();
            }}
          >
            了解しました
          </button>
        )}
      </div>
    </div>
  );
};
