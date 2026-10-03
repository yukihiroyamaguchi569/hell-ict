import { rateLimitNotice, stage1DraftLabels } from "@hell-ict/content";
import { stage1MailIdSchema } from "@hell-ict/domain";
import type { Stage1MailId, Stage1State, TeamCode } from "@hell-ict/domain";
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import type { WritableComputedRef } from "vue";
import { z } from "zod";

import { classifyDraftSend } from "../../chat/send-outcome.js";
import type { DraftSendOutcome } from "../../chat/send-outcome.js";
import type { GameSession } from "../../composables/use-game-session.js";
import type { Clock, HttpPort, KeyValueStorage, Scheduler } from "../../ports.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import { sendStage1Draft } from "./s1-draft-api.js";
import type { Stage1DraftCommand } from "./s1-draft-api.js";
import { stage1CanOpen } from "./s1-view.js";
import type { Stage1 } from "./use-stage1.js";

/** How long the draft button shows a notice before it reads 「AIに下書きさせる」 again. */
export const STAGE1_DRAFT_NOTICE_MS = 2_400;
/** The same for 「要点か、コンテキストが必要です」 (nothing was sent; the mock's 1600 ms). */
export const STAGE1_DRAFT_NO_MATERIAL_MS = 1_600;

const draftRecordSchema = z
  .object({
    stageStartedAt: z.number(),
    roundStartedAt: z.number(),
    round: z.number().int(),
    context: z.string(),
    bodies: z.record(z.string(), z.string()),
    points: z.record(z.string(), z.string()),
    memo: z.string(),
  })
  .strict();

/** What the reply boxes hold for one try of one round (`hellVueStage1Draft:<code>`). */
export type Stage1DraftRecord = z.infer<typeof draftRecordSchema>;

const pendingSchema = z
  .object({
    mailId: stage1MailIdSchema,
    context: z.string(),
    point: z.string(),
    commandId: z.string().min(1),
  })
  .strict();

type PendingDraft = z.infer<typeof pendingSchema>;

/** At most this many unsettled drafts are remembered per try (the oldest goes first). */
export const STAGE1_DRAFT_PENDING_MAX = 8;

const pendingListSchema = z
  .object({
    roundStartedAt: z.number(),
    entries: z.array(pendingSchema).max(STAGE1_DRAFT_PENDING_MAX),
  })
  .strict();

/** The unsettled draft requests of one try: another try never reuses their ids. */
type PendingList = z.infer<typeof pendingListSchema>;

/** sessionStorage key of the draft requests whose outcome is not settled yet. */
export const stage1DraftPendingKey = (teamCode: TeamCode): string =>
  `hellStage1DraftPending:${teamCode}`;

/**
 * The record for the try now running. Each try starts with empty bodies and key points (a new
 * round, or an R3 retry: `roundStartedAt` moved). The context box is the round's: it stays over
 * an R3 retry, since the pasted handover memo is what the retry is about, and a new round or a
 * new stage empties it. Returns `record` itself when it is already this try's.
 */
export const stage1DraftRecordFor = (
  record: Stage1DraftRecord | null,
  s1: Stage1State,
): Stage1DraftRecord => {
  const fresh: Stage1DraftRecord = {
    stageStartedAt: s1.stageStartedAt,
    roundStartedAt: s1.roundStartedAt,
    round: s1.round,
    context: "",
    bodies: {},
    points: {},
    memo: "",
  };
  if (record === null || record.stageStartedAt !== s1.stageStartedAt) return fresh;
  if (record.round !== s1.round) return fresh;
  if (record.roundStartedAt !== s1.roundStartedAt) return { ...fresh, context: record.context };
  return record;
};

/**
 * What pressing [AIに下書きさせる] came to.
 * - closed: nothing to draft for now (R1, the mail is not live, the round is over, a draft is on
 *   its way); nothing was sent.
 * - no-material: the key points and the context are both blank; nothing was sent.
 * - sent: the server's answer, as `classifyDraftSend` reads it.
 */
export type Stage1DraftPress =
  | { readonly kind: "closed" | "no-material" }
  | { readonly kind: "sent"; readonly outcome: DraftSendOutcome };

export interface Stage1DraftDeps {
  readonly session: GameSession;
  /** `useStage1`'s state and rows: the draft follows its tries and opens only live mails. */
  readonly stage: Pick<Stage1, "state" | "rows">;
  readonly sessionStorage: KeyValueStorage;
  readonly scheduler: Scheduler;
  readonly http: HttpPort;
  readonly clock: Clock;
}

export interface Stage1Draft {
  /** The context box (the round's, shared by every mail). */
  readonly context: WritableComputedRef<string>;
  /** The reply to the handover memo. */
  readonly memo: WritableComputedRef<string>;
  body(mailId: Stage1MailId): string;
  setBody(mailId: Stage1MailId, text: string): void;
  point(mailId: Stage1MailId): string;
  setPoint(mailId: Stage1MailId, text: string): void;
  /** The draft button's words for this mail: idle, busy, or a notice for a while. */
  label(mailId: Stage1MailId): string;
  /** A draft for this mail is on its way (the button is disabled). */
  busy(mailId: Stage1MailId): boolean;
  draft(mailId: Stage1MailId): Promise<Stage1DraftPress>;
}

const CLOSED: Stage1DraftPress = { kind: "closed" };
const NO_MATERIAL: Stage1DraftPress = { kind: "no-material" };

/** The id stays for the next press of the same draft only while the server may have stored it. */
const keepsCommandId = (outcome: DraftSendOutcome): boolean =>
  outcome.kind === "saved-retry" || outcome.kind === "rate-limited" || outcome.kind === "stale";

/** Whether the game is read again: the server may have moved on (PII trap, gate, stage). */
const refetchesGame = (outcome: DraftSendOutcome): boolean =>
  outcome.kind === "draft-rejected" ||
  outcome.kind === "stage-moved" ||
  (outcome.kind === "unsaved" && outcome.reason === "pii-blocked");

/** The button's notice, or `null`: a draft goes into the body, a stale tab shows the reload. */
const noticeFor = (outcome: DraftSendOutcome): string | null => {
  if (outcome.kind === "ok" || outcome.kind === "stale") return null;
  if (outcome.kind === "rate-limited") return rateLimitNotice(outcome.retryAfterSeconds);
  return stage1DraftLabels.failed;
};

const samePending = (pending: PendingDraft, next: Omit<PendingDraft, "commandId">): boolean =>
  pending.mailId === next.mailId &&
  pending.context === next.context &&
  pending.point === next.point;

/** The unsettled requests of the try `tryOf` (those of another try are dropped). */
const pendingOfTry = (list: PendingList | null, tryOf: number): readonly PendingDraft[] =>
  list?.roundStartedAt === tryOf ? list.entries : [];

/**
 * The reply boxes of Stage 1 and its [AIに下書きさせる] (the mock's s1Draft / s1DraftLive). The
 * boxes are kept in sessionStorage per try; the draft goes to the stage's AI route, one at a
 * time, and a press of the same draft again (same mail, context and key points) reuses the
 * commandId of one whose outcome is unknown, so the server never drafts it twice. The button
 * tells how it went for a while (Stage 1 has no chat pane to say it in).
 */
export const useStage1Draft = (deps: Stage1DraftDeps): Stage1Draft => {
  const { session, stage, scheduler } = deps;
  const record = shallowRef<Stage1DraftRecord | null>(null);
  const inFlight = shallowRef<Stage1MailId | null>(null);
  const notice = shallowRef<{ mailId: Stage1MailId; text: string } | null>(null);
  let cancelNotice: (() => void) | null = null;
  let disposed = false;
  /** The unsettled draft request, kept here too in case the storage cannot hold it. */
  let pendingInMemory: PendingList | null = null;

  const draftStore = () => {
    const code = session.teamCode.value;
    return code === null
      ? null
      : sessionRecord(
          deps.sessionStorage,
          sessionRecordKey("Stage1Draft", code),
          draftRecordSchema,
        );
  };
  const pendingStore = () => {
    const code = session.teamCode.value;
    return code === null
      ? null
      : sessionRecord(deps.sessionStorage, stage1DraftPendingKey(code), pendingListSchema);
  };

  const save = (next: Stage1DraftRecord): void => {
    record.value = next;
    draftStore()?.write(next);
  };

  // Follow the tries: a reload finds its boxes, a new try empties them.
  watch(
    () => stage.state.value,
    (s1) => {
      if (s1 === null) return;
      const current = record.value ?? draftStore()?.read() ?? null;
      const next = stage1DraftRecordFor(current, s1);
      if (next !== record.value) save(next);
    },
    { immediate: true },
  );

  const patch = (change: Partial<Stage1DraftRecord>): void => {
    if (record.value !== null) save({ ...record.value, ...change });
  };
  const field = (key: "context" | "memo") =>
    computed({
      get: () => record.value?.[key] ?? "",
      set: (text: string) => {
        patch({ [key]: text });
      },
    });

  const clearNotice = (): void => {
    cancelNotice?.();
    cancelNotice = null;
    notice.value = null;
  };
  const showNotice = (mailId: Stage1MailId, text: string, ms: number): void => {
    clearNotice();
    notice.value = { mailId, text };
    cancelNotice = scheduler.schedule(() => {
      notice.value = null;
      cancelNotice = null;
    }, ms);
  };
  onScopeDispose(() => {
    disposed = true;
    cancelNotice?.();
  });

  /** The commandId for this draft: the unsettled one when it is the same draft, else a new one. */
  // Storage first (a reload left it there), then memory: when the storage is blocked or full,
  // this tab still resends the same draft with the same id.
  const readPending = (): PendingList | null => pendingStore()?.read() ?? pendingInMemory;
  const writePending = (next: PendingList): void => {
    pendingInMemory = next.entries.length === 0 ? null : next;
    if (pendingInMemory === null) pendingStore()?.clear();
    else pendingStore()?.write(pendingInMemory);
  };

  /** The commandId for this draft: the unsettled one of the same draft in this try, else new. */
  const commandIdFor = (draft: Omit<PendingDraft, "commandId">, tryOf: number): string => {
    const entries = pendingOfTry(readPending(), tryOf);
    const kept = entries.find((entry) => samePending(entry, draft));
    if (kept !== undefined) return kept.commandId;
    const commandId = session.newCommandId();
    const next = [...entries, { ...draft, commandId }].slice(-STAGE1_DRAFT_PENDING_MAX);
    writePending({ roundStartedAt: tryOf, entries: next });
    return commandId;
  };

  /** An id the server settled (or never stored) is not kept for the next press. */
  const forgetUnlessKept = (outcome: DraftSendOutcome, commandId: string): void => {
    if (keepsCommandId(outcome)) return;
    const list = readPending();
    if (list === null) return;
    const entries = list.entries.filter((entry) => entry.commandId !== commandId);
    if (entries.length !== list.entries.length) writePending({ ...list, entries });
  };

  const settle = (outcome: DraftSendOutcome, sent: Stage1DraftCommand, tryOf: number): void => {
    forgetUnlessKept(outcome, sent.commandId);
    if (outcome.kind === "stale") session.markStale();
    if (refetchesGame(outcome)) void session.refresh();
    if (disposed) return;
    // A draft that comes back after its try is over has no box to go into.
    const boxes = record.value;
    if (outcome.kind === "ok" && boxes?.roundStartedAt === tryOf) {
      patch({ bodies: { ...boxes.bodies, [sent.mailId]: outcome.result.assistant.text } });
    }
    const text = noticeFor(outcome);
    if (text !== null) showNotice(sent.mailId, text, STAGE1_DRAFT_NOTICE_MS);
  };

  /** A live mail of R2 or R3 while the round runs, and nothing else on its way. */
  const draftableTry = (mailId: Stage1MailId): number | null => {
    const s1 = stage.state.value;
    if (inFlight.value !== null || s1?.status.phase !== "playing" || s1.round === 1) return null;
    return stage1CanOpen(stage.rows.value, mailId) ? s1.roundStartedAt : null;
  };

  /** What a press would send, or `null` when there is nothing to send it to. */
  const pressTarget = (mailId: Stage1MailId) => {
    const tryOf = draftableTry(mailId);
    const teamCode = session.teamCode.value;
    const generation = session.generation.value;
    const boxes = record.value;
    if (tryOf === null || teamCode === null || generation === null || boxes === null) return null;
    const material = { mailId, context: boxes.context, point: boxes.points[mailId] ?? "" };
    return { tryOf, teamCode, generation, material };
  };

  const draft = async (mailId: Stage1MailId): Promise<Stage1DraftPress> => {
    const target = pressTarget(mailId);
    if (target === null) return CLOSED;
    const { context, point } = target.material;
    if (context.trim() === "" && point.trim() === "") {
      showNotice(mailId, stage1DraftLabels.noMaterial, STAGE1_DRAFT_NO_MATERIAL_MS);
      return NO_MATERIAL;
    }
    const command: Stage1DraftCommand = {
      type: "s1-draft",
      commandId: commandIdFor(target.material, target.tryOf),
      generation: target.generation,
      ...target.material,
    };
    inFlight.value = mailId;
    clearNotice();
    let outcome: DraftSendOutcome;
    try {
      const result = await sendStage1Draft(deps.http, deps.clock, target.teamCode, command);
      outcome = classifyDraftSend(result, point);
    } finally {
      inFlight.value = null;
    }
    settle(outcome, command, target.tryOf);
    return { kind: "sent", outcome };
  };

  return {
    context: field("context"),
    memo: field("memo"),
    body: (mailId) => record.value?.bodies[mailId] ?? "",
    setBody: (mailId, text) => {
      if (record.value !== null) patch({ bodies: { ...record.value.bodies, [mailId]: text } });
    },
    point: (mailId) => record.value?.points[mailId] ?? "",
    setPoint: (mailId, text) => {
      if (record.value !== null) patch({ points: { ...record.value.points, [mailId]: text } });
    },
    label: (mailId) => {
      if (inFlight.value === mailId) return stage1DraftLabels.busy;
      return notice.value?.mailId === mailId ? notice.value.text : stage1DraftLabels.idle;
    },
    busy: (mailId) => inFlight.value === mailId,
    draft,
  };
};
