import type { Clock } from "@hell-ict/domain/ports";

/** Clock portの本番実装。Stage 1のラウンド1締切判定が最初の実利用箇所。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
