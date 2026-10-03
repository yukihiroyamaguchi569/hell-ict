import { estimateServerOffsetMs, toServerTime } from "@hell-ict/domain";
import { readonly, ref } from "vue";
import type { Ref } from "vue";

import type { Clock } from "../ports.js";

export interface ServerClock {
  /** How far the server's clock is ahead of this PC's (negative when behind). */
  readonly offsetMs: Readonly<Ref<number>>;
  /**
   * Learns the offset from one round trip. `requestSentAt` is this PC's clock when the request
   * left; the answer's arrival is read now.
   */
  record(requestSentAt: number, serverNow: number): void;
  /** The server's time now, as epoch ms. Countdowns to server deadlines use this. */
  now(): number;
}

/**
 * The server's clock as seen from this PC. Deadlines are judged by the server's clock, so a PC
 * whose clock is a minute off must still count down to the same moment (domain's
 * `estimateServerOffsetMs`). Until the first answer, the PC's own clock is used as is.
 */
export const useServerClock = (clock: Clock): ServerClock => {
  const offsetMs = ref(0);
  return {
    offsetMs: readonly(offsetMs),
    record(requestSentAt, serverNow) {
      offsetMs.value = estimateServerOffsetMs({
        requestSentAt,
        responseReceivedAt: clock.now().getTime(),
        serverNow,
      });
    },
    now: () => toServerTime(clock.now().getTime(), offsetMs.value),
  };
};
