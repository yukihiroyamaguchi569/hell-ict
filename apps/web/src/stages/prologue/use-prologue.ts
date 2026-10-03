import { inboxMailIdSchema, inboxSettleAt } from "@hell-ict/domain";
import type { InboxMailId, InboxState } from "@hell-ict/domain";
import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { z } from "zod";

import { useAtServerTime } from "../../composables/use-at-server-time.js";
import type { ServerMoment } from "../../composables/use-at-server-time.js";
import type { SendOutcome } from "../../composables/use-game-session.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import type { InboxRow, StageContext } from "../stage-module.js";
import { liveOpenMail, prologueRows } from "./prologue-view.js";

/** How long the send button says 「本文が空です」 (mock inboxSend). */
export const EMPTY_NOTICE_MS = 1_600;
/** Waits before asking again for a settle the server found early (its clock is the judge). */
export const INBOX_SETTLE_RETRY_MS = 1_000;
/** A settle is asked for at most this many times. */
export const INBOX_SETTLE_MAX_TRIES = 10;
/** Waits before sending `advance` again, under the same commandId, after no answer. */
export const ADVANCE_RETRY_MS = 2_000;

/** empty: blank, nothing sent. closed: the mail is not open, or a reply is on its way. */
export type ProloguePress = "empty" | "closed" | SendOutcome["kind"];

export interface Prologue {
  readonly rows: ComputedRef<readonly InboxRow[]>;
  /** The mail the centre shows with its reply box, or `null` for the note. */
  readonly openMail: ComputedRef<InboxMailId | null>;
  /** The send button says 「本文が空です」. */
  readonly emptyShown: Readonly<Ref<boolean>>;
  /** A reply to this mail is on its way (another mail can still be answered meanwhile). */
  busy(id: InboxMailId): boolean;
  draft(id: InboxMailId): string;
  setDraft(id: InboxMailId, text: string): void;
  reply(id: InboxMailId): Promise<ProloguePress>;
}

/** The drafts, for the inbox opened at `openedAt` only (another opening starts empty). */
const draftsSchema = z
  .object({
    openedAt: z.number(),
    drafts: z.partialRecord(inboxMailIdSchema, z.string()),
  })
  .strict();
type Drafts = z.infer<typeof draftsSchema>["drafts"];

/** The settle went through, or it is not this screen's to send any more. */
const settleIsOver = (outcome: SendOutcome): boolean => {
  if (outcome.kind !== "done") return outcome.kind !== "unavailable" && outcome.kind !== "failed";
  const { response } = outcome;
  return response.status !== "rejected" || response.reason !== "mails-open";
};

/**
 * The Prologue's inbox: replies, drafts kept in sessionStorage (`hellVueInbox:<code>`), the
 * deadline reported on the server's clock (`inbox.settle`: `GET /game` never judges), and the
 * move to Stage 1 once the Prologue is cleared (`advance`: the scene stays on the inbox, so no
 * clear effect sends it).
 */
export const usePrologue = (context: StageContext): Prologue => {
  const { session, serverNow, scheduler, mail } = context;
  const cancels = new Set<() => void>();
  /** A timer of this stay: dropped when the team leaves the Prologue. */
  const later = (task: () => void, delayMs: number): (() => void) => {
    const cancel = scheduler.schedule(() => {
      cancels.delete(cancel);
      task();
    }, delayMs);
    cancels.add(cancel);
    return () => {
      cancels.delete(cancel);
      cancel();
    };
  };
  onScopeDispose(() => {
    for (const cancel of cancels) cancel();
  });

  const state = computed(() => {
    const game = session.view.value?.state;
    return game?.game.stage === "prologue" ? game : null;
  });
  const inbox = computed((): InboxState | null => state.value?.inbox ?? null);
  const cleared = computed(() => state.value?.game.clearedAt.prologue !== undefined);
  const openMail = computed(() => liveOpenMail(inbox.value, mail.openId.value, serverNow.value));
  // A mail that closed while open (its deadline, or the reply went through) leaves the centre.
  watch(
    () => openMail.value === null && mail.openId.value !== null,
    (stale) => {
      if (stale) mail.close();
    },
  );

  const record = () => {
    const code = session.teamCode.value;
    return code === null
      ? null
      : sessionRecord(context.sessionStorage, sessionRecordKey("Inbox", code), draftsSchema);
  };
  const drafts = shallowRef<Drafts>({});
  watch(
    [session.teamCode, () => inbox.value?.openedAt],
    ([, openedAt]) => {
      const saved = record()?.read() ?? null;
      drafts.value = saved !== null && saved.openedAt === openedAt ? saved.drafts : {};
    },
    { immediate: true },
  );
  const setDraft = (id: InboxMailId, text: string): void => {
    drafts.value = { ...drafts.value, [id]: text };
    const openedAt = inbox.value?.openedAt;
    if (openedAt !== undefined) record()?.write({ openedAt, drafts: drafts.value });
  };

  const emptyShown = ref(false);
  let hideEmpty: (() => void) | null = null;
  const showEmpty = (): void => {
    // Pressed again while it shows: the 1600 ms count from the last press.
    hideEmpty?.();
    emptyShown.value = true;
    hideEmpty = later(() => {
      emptyShown.value = false;
    }, EMPTY_NOTICE_MS);
  };

  const inFlight = shallowRef<ReadonlySet<InboxMailId>>(new Set());
  const setInFlight = (id: InboxMailId, on: boolean): void => {
    const next = new Set(inFlight.value);
    if (on) next.add(id);
    else next.delete(id);
    inFlight.value = next;
  };
  const reply = async (id: InboxMailId): Promise<ProloguePress> => {
    const text = drafts.value[id] ?? "";
    if (text.trim() === "") {
      showEmpty();
      return "empty";
    }
    if (inFlight.value.has(id) || liveOpenMail(inbox.value, id, serverNow.value) === null) {
      return "closed";
    }
    setInFlight(id, true);
    let outcome: SendOutcome;
    try {
      outcome = await session.send({ type: "inbox.reply", mailId: id, text });
    } finally {
      // A send that throws must not leave this mail's button disabled for good.
      setInFlight(id, false);
    }
    // Sent, or refused because the mail closed meanwhile: either way it is not answered again.
    // The centre is not closed here: the watch above closes this mail if it is still open, and
    // leaves alone another mail opened while the answer was on its way.
    if (outcome.kind === "done") setDraft(id, "");
    return outcome.kind;
  };

  // Each try is its own moment: a settle the server found early (the screen's estimate of the
  // server's clock ran ahead) is asked again a little later.
  const settleTry = ref(0);
  const settleMoment = (): ServerMoment | null => {
    const current = inbox.value;
    if (current === null || cleared.value || settleTry.value >= INBOX_SETTLE_MAX_TRIES) return null;
    return {
      key: `${String(current.openedAt)}:${String(settleTry.value)}`,
      at: inboxSettleAt(current),
    };
  };
  useAtServerTime(serverNow, settleMoment, (key) => {
    void session.send({ type: "inbox.settle" }).then((outcome) => {
      if (settleIsOver(outcome)) return;
      later(() => {
        if (settleMoment()?.key === key) settleTry.value += 1;
      }, INBOX_SETTLE_RETRY_MS);
    });
  });

  // Cleared: on to Stage 1. One commandId for this stay, so a resend after no answer comes back
  // `duplicate` if the first one was applied after all.
  let advanceId: string | null = null;
  let advancing = false;
  const sendAdvance = (): void => {
    if (advancing) return;
    advancing = true;
    advanceId ??= session.newCommandId();
    void session
      .send({ type: "advance", from: "prologue", to: "s1" }, advanceId)
      .then((outcome) => {
        advancing = false;
        if (outcome.kind === "unavailable") later(sendAdvance, ADVANCE_RETRY_MS);
      });
  };
  watch(
    cleared,
    (now) => {
      if (now) sendAdvance();
    },
    { immediate: true },
  );

  return {
    rows: computed(() => (inbox.value === null ? [] : prologueRows(inbox.value, serverNow.value))),
    openMail,
    emptyShown: readonly(emptyShown),
    busy: (id) => inFlight.value.has(id),
    draft: (id) => drafts.value[id] ?? "",
    setDraft,
    reply,
  };
};
