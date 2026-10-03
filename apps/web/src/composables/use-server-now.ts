import { onScopeDispose, readonly, ref, watch } from "vue";
import type { Ref } from "vue";

import type { Scheduler } from "../ports.js";
import type { ServerClock } from "./use-server-clock.js";

/** How often the clocks on screen are redrawn (the mock's frames run every 250 ms). */
export const SERVER_NOW_TICK_MS = 250;

/**
 * The server's time, refreshed every SERVER_NOW_TICK_MS: the header clock and the countdowns
 * read it. The timer goes through the Scheduler port, so tests move time by hand. It is also
 * read again as soon as the offset to the server is learnt (an answer arrived), so the first
 * frame after joining is not drawn with the PC's own clock.
 */
export const useServerNow = (
  serverClock: Pick<ServerClock, "now" | "offsetMs">,
  scheduler: Scheduler,
): Readonly<Ref<number>> => {
  const current = ref(serverClock.now());
  let cancel: () => void = () => undefined;
  const tick = (): void => {
    current.value = serverClock.now();
    cancel = scheduler.schedule(tick, SERVER_NOW_TICK_MS);
  };
  cancel = scheduler.schedule(tick, SERVER_NOW_TICK_MS);
  watch(serverClock.offsetMs, () => {
    current.value = serverClock.now();
  });
  onScopeDispose(() => {
    cancel();
  });
  return readonly(current);
};
