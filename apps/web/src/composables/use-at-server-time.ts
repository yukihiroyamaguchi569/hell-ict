import { watch } from "vue";
import type { Ref } from "vue";

/** A moment by the server's clock, named so it runs once however often it is asked for. */
export interface ServerMoment {
  readonly key: string;
  /** Server epoch ms. */
  readonly at: number;
}

/** The moment's key when it is due and has not run yet, else `null`. Pure. */
export const dueMomentKey = (
  moment: ServerMoment | null,
  serverNowMs: number,
  done: ReadonlySet<string>,
): string | null =>
  moment !== null && serverNowMs >= moment.at && !done.has(moment.key) ? moment.key : null;

/**
 * Calls `run` once when the server's clock reaches the moment `target` names (a deadline that
 * the screen has to report, as `inbox.settle` at the Prologue's). Once per key: the clock ticks
 * every 250 ms, and a moment already past when the screen comes up runs straight away, once.
 * A new key (the next round, another attempt) runs again. The keys are kept in memory only: a
 * reload may run a moment again, so what `run` sends must be safe to send twice.
 */
export const useAtServerTime = (
  serverNow: Readonly<Ref<number>>,
  target: () => ServerMoment | null,
  run: (key: string) => void,
): void => {
  const done = new Set<string>();
  watch(
    [serverNow, target],
    ([now, moment]) => {
      const key = dueMomentKey(moment, now, done);
      if (key === null) return;
      done.add(key);
      run(key);
    },
    { immediate: true },
  );
};
