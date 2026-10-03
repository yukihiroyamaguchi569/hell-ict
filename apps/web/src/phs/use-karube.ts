import { phsBusyLine } from "@hell-ict/content";
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { z } from "zod";

import type { KeyValueStorage, Scheduler } from "../ports.js";
import { sessionRecord, sessionRecordKey, type SessionRecord } from "../session-record.js";
import type { KarubeCall, StageInstance } from "../stages/stage-module.js";

/*
 * 苅部さん's phone (mock `phsRing` and the `#phs-bar` click, index.html 9576-9690). A stage only
 * says what he says now (`StageInstance.karube`); this rings, badges and shows it.
 *
 * Which calls have rung and which have been read is kept per team in sessionStorage
 * (`hellVueKarube:<code>`), so a reload neither rings a call again nor badges a read one. What
 * the window shows is memory only, per stay in a stage: a new stage starts with an empty window.
 */

/** The mock's gap between two of his lines. */
export const KARUBE_LINE_GAP_MS = 900;
/** How long the busy answer to a reply takes (mock `phsSendReply`). */
export const KARUBE_REPLY_DELAY_MS = 1500;

const recordSchema = z.object({
  rung: z.array(z.string()).readonly(),
  read: z.array(z.string()).readonly(),
});

interface CallIds {
  readonly rung: ReadonlySet<string>;
  readonly read: ReadonlySet<string>;
}

export interface KarubeRecord {
  /** The calls that have been opened. A stage may wait for one (Stage 2 shows the AI). */
  readonly read: ComputedRef<ReadonlySet<string>>;
  hasRung(callId: string): boolean;
  markRung(callId: string): void;
  markRead(callId: string): void;
}

/** Kept in memory as well: blocked storage only means a reload forgets. */
export const useKarubeRecord = (
  storage: KeyValueStorage,
  teamCode: Readonly<Ref<string | null>>,
): KarubeRecord => {
  const ids = shallowRef<CallIds>({ rung: new Set(), read: new Set() });
  let record: SessionRecord<z.infer<typeof recordSchema>> | null = null;

  watch(
    teamCode,
    (code) => {
      record =
        code === null
          ? null
          : sessionRecord(storage, sessionRecordKey("Karube", code), recordSchema);
      const saved = record?.read();
      ids.value = { rung: new Set(saved?.rung ?? []), read: new Set(saved?.read ?? []) };
    },
    { immediate: true },
  );

  const save = (next: CallIds): void => {
    ids.value = next;
    record?.write({ rung: [...next.rung], read: [...next.read] });
  };

  return {
    read: computed(() => ids.value.read),
    hasRung: (callId) => ids.value.rung.has(callId),
    markRung(callId) {
      if (ids.value.rung.has(callId)) return;
      save({ ...ids.value, rung: new Set([...ids.value.rung, callId]) });
    },
    markRead(callId) {
      if (ids.value.read.has(callId)) return;
      save({ ...ids.value, read: new Set([...ids.value.read, callId]) });
    },
  };
};

/** `karube`: his words. `wait`: the busy answer. `me`: what the team sent him. */
export interface KarubeLine {
  readonly key: number;
  readonly kind: "karube" | "wait" | "me";
  readonly text: string;
}

export interface KarubePhone {
  /** From his first call in the stage (mock `#phs` stays hidden until `phsRing`). */
  readonly visible: ComputedRef<boolean>;
  readonly open: Readonly<Ref<boolean>>;
  /** How many calls came in this stay, while one of them is unread; else `null`. */
  readonly badge: ComputedRef<number | null>;
  readonly log: Readonly<Ref<readonly KarubeLine[]>>;
  toggle(): void;
  reply(text: string): void;
}

export interface KarubeOptions {
  readonly record: KarubeRecord;
  /** The stage on screen: a new instance is a new stay, with an empty window. */
  readonly instance: () => StageInstance | null;
  readonly scheduler: Scheduler;
  /**
   * Plays the ring tone: once for the new calls of one update (never twice in a row), and never
   * again for a call that rang before a reload.
   */
  readonly onRing: () => void;
}

export const useKarube = ({ record, instance, scheduler, onRing }: KarubeOptions): KarubePhone => {
  const open = shallowRef(false);
  const log = shallowRef<readonly KarubeLine[]>([]);
  /** Every call of this stay, in order: a newer call never drops an unread older one. */
  const calls = shallowRef<readonly KarubeCall[]>([]);
  const shown = new Set<string>();
  let cancels: (() => void)[] = [];
  let nextKey = 0;

  const append = (kind: KarubeLine["kind"], text: string): void => {
    log.value = [...log.value, { key: nextKey++, kind, text }];
  };
  const later = (task: () => void, delayMs: number): void => {
    cancels.push(scheduler.schedule(task, delayMs));
  };
  const leaveStay = (): void => {
    for (const cancel of cancels) cancel();
    cancels = [];
    open.value = false;
    log.value = [];
    calls.value = [];
    shown.clear();
  };

  /**
   * Keeps a call not seen before in this stay. Returns whether it has never rung (a reload keeps
   * the rung ones silent).
   */
  const receive = (call: KarubeCall): boolean => {
    if (calls.value.some((known) => known.callId === call.callId)) return false;
    calls.value = [...calls.value, call];
    if (record.hasRung(call.callId)) return false;
    record.markRung(call.callId);
    return true;
  };

  watch(
    () => [instance(), instance()?.karube?.value ?? []] as const,
    ([stay, incoming], previous) => {
      if (stay !== previous?.[0]) leaveStay();
      // Every call is received (badge, read state), but calls arriving together ring once: the
      // audio element is rewound by a second play, so two rings in a row would sound as one.
      const fresh = incoming.map(receive);
      if (fresh.includes(true)) onRing();
    },
    { immediate: true },
  );
  onScopeDispose(leaveStay);

  /** Read before (a reload): all at once. New: one line every 900 ms, the first at once. */
  const showUnshownCalls = (): boolean => {
    const unshown = calls.value.filter((call) => !shown.has(call.callId));
    const dripped: string[] = [];
    for (const call of unshown) {
      shown.add(call.callId);
      if (record.read.value.has(call.callId)) {
        for (const line of call.lines) append("karube", line);
      } else {
        dripped.push(...call.lines);
        record.markRead(call.callId);
      }
    }
    dripped.forEach((line, i) => {
      const show = (): void => {
        append("karube", line);
      };
      if (i === 0) show();
      else later(show, KARUBE_LINE_GAP_MS * i);
    });
    return unshown.length > 0;
  };

  return {
    visible: computed(() => calls.value.length > 0),
    open,
    badge: computed(() =>
      calls.value.some((call) => !record.read.value.has(call.callId)) ? calls.value.length : null,
    ),
    log,
    toggle() {
      open.value = !open.value;
      if (!open.value) return;
      if (!showUnshownCalls() && log.value.length === 0) append("wait", phsBusyLine);
    },
    reply(text) {
      const trimmed = text.trim();
      if (trimmed === "") return;
      append("me", trimmed);
      later(() => {
        append("wait", phsBusyLine);
      }, KARUBE_REPLY_DELAY_MS);
    },
  };
};
