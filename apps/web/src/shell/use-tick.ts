import { useEffect, useState } from "react";

/**
 * 250ms間隔で現在時刻(ms)を返す（docs/ui/02_Stage1.md 実装メモの `s1Frame()` 間隔に合わせる）。
 * 1秒間隔だと残り時間の減り方がカクつき、締切の緊張が落ちる。
 */
export const useTick = (intervalMs = 250): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
};
