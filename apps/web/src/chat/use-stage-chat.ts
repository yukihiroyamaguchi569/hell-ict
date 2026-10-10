import {
  detectPii,
  forgetPending,
  forgetPiiPending,
  mergePending,
  parseStoredPending,
  pendingIdFor,
  pendingKey,
  pendingQueryIds,
  reconcilePending,
  storedPendingText,
} from "@hell-ict/domain";
import type { ChatSnapshot, PendingCommands, StageAi, TeamCode } from "@hell-ict/domain";
import { computed, effectScope, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { ChatApi } from "../api/chat-api.js";
import type { GameSession } from "../composables/use-game-session.js";
import type { IdGenerator, KeyValueStorage } from "../ports.js";
import { chatPaneMode, newerSnapshot, stageThreadMessages } from "./chat-view.js";
import type { ChatPaneMode } from "./chat-view.js";
import { chatPaneItems } from "./pane-items.js";
import type { ChatNotice, ChatPaneItem, InFlightMessage } from "./pane-items.js";
import { chatNoticeText, chatSendFollowUp, classifyChatSend } from "./send-outcome.js";
import type { ChatSendOutcome } from "./send-outcome.js";

export interface StageChatDeps {
  readonly api: ChatApi;
  readonly session: GameSession;
  readonly ids: IdGenerator;
  /** sessionStorage: the unconfirmed command ids go with the tab. */
  readonly storage: KeyValueStorage;
}

export interface StageChat {
  readonly mode: ComputedRef<ChatPaneMode>;
  /** The bubbles to draw: the current stage's conversation only. */
  readonly items: ComputedRef<readonly ChatPaneItem[]>;
  /** The text in the input. Emptied when sent; given back when the send fails. */
  readonly draft: Ref<string>;
  /** A message is on its way: the input and the send button are closed. */
  readonly sending: ComputedRef<boolean>;
  /** The stage's conversation is being prepared again ([再試行] after `failed`). */
  readonly preparing: ComputedRef<boolean>;
  /**
   * How many times the pane has said the PII gate blocked a message (its notice shown). Only
   * counts up: a stage watches it to sound the block (Stage 5, Issue #29).
   */
  readonly piiBlocks: Readonly<Ref<number>>;
  /** Sends the draft to the current stage's AI (live stages only). Never resends by itself. */
  send(): Promise<void>;
  /** After `ai.status=failed`: asks the server again to prepare the stage's conversation. */
  retryPrepare(): Promise<void>;
  dispose(): void;
}

/** sessionStorage key of a team's unconfirmed chat command ids (not the mock's `hellPending:*`). */
export const pendingStorageKey = (teamCode: TeamCode): string => `hellStageChatPending:${teamCode}`;

const NO_AI: StageAi = { status: "none" };

/** What one send is fixed to when it leaves: the join, the thread, the text and its id. */
interface SendContext {
  readonly teamCode: TeamCode;
  readonly generation: number;
  /** `session.currentJoin()` when it left. */
  readonly join: number;
  readonly threadId: string;
  readonly text: string;
  readonly key: string;
  /**
   * The text holds personal information (`detectPii`, user decision 1 of 2026-09-27). The Worker
   * refuses it before OpenAI; the screen only keeps it from leaving a trace: no pending id in
   * sessionStorage, no bubble of it on its way, and the game fetched again whatever comes back.
   */
  readonly pii: boolean;
}

/**
 * The AI pane of the current stage. Draws only the thread `GET /game` names (`ai.threadId`):
 * the chat holds past stages too, and the pane never falls back to one of them. The server
 * picks the thread and the prompt; the pane keeps the commandId of each unconfirmed message so
 * that pressing again with the same text never stores it twice.
 */
export const createStageChat = (deps: StageChatDeps): StageChat => {
  const { session } = deps;
  const scope = effectScope(true);
  const snapshot = shallowRef<ChatSnapshot | null>(null);
  const draft = ref("");
  const sending = ref(false);
  const preparing = ref(false);
  const inFlight = shallowRef<InFlightMessage | null>(null);
  const notices = shallowRef<readonly ChatNotice[]>([]);
  const piiBlocks = ref(0);
  let pending: PendingCommands = new Map();
  let noticeSeq = 0;
  /** The join whose chat the pane shows (0: none). */
  let loadedJoin = 0;
  /** The team whose unconfirmed ids `pending` holds. */
  let pendingTeam: TeamCode | null = null;
  let loading = false;

  const ai = computed(() => session.view.value?.ai ?? NO_AI);
  const threadId = computed(() => (ai.value.status === "ready" ? ai.value.threadId : null));
  const messages = computed(() => stageThreadMessages(snapshot.value, ai.value));
  const mode = computed(() => chatPaneMode(ai.value));
  const items = computed(() =>
    chatPaneItems(messages.value, notices.value, inFlight.value, threadId.value),
  );

  /** Nothing is written once the tab is stale (the game master reset the team). */
  const writable = (): boolean => session.status.value === "ready";
  const isCurrentTeam = (teamCode: TeamCode): boolean => session.teamCode.value === teamCode;

  // sessionStorage may throw (blocked site data): the chat goes on with the ids in memory.
  const readPending = (teamCode: TeamCode): PendingCommands => {
    try {
      return parseStoredPending(deps.storage.getItem(pendingStorageKey(teamCode)));
    } catch {
      return new Map();
    }
  };

  const savePending = (teamCode: TeamCode, next: PendingCommands): void => {
    if (next === pending || !isCurrentTeam(teamCode)) return;
    pending = next;
    if (!writable()) return;
    const key = pendingStorageKey(teamCode);
    try {
      if (next.size === 0) deps.storage.removeItem(key);
      else deps.storage.setItem(key, storedPendingText(next));
    } catch {
      // Kept in memory only: a reload then sends the same text with a fresh id.
    }
  };

  const fetchChat = async (
    teamCode: TeamCode,
    commandIds?: readonly string[],
  ): Promise<ChatSnapshot | null> => {
    const join = session.currentJoin();
    const result = await deps.api.fetchChat(teamCode, commandIds);
    // An answer to an earlier join (even of the same team) is not this session's chat.
    if (result.kind !== "ok" || session.currentJoin() !== join) return null;
    snapshot.value = newerSnapshot(snapshot.value, result.value);
    return result.value;
  };

  /** Entering (or reloading): the chat, and where each id this tab left unconfirmed stands. */
  const load = async (teamCode: TeamCode): Promise<void> => {
    loading = true;
    // `pending` holds what the previous join of this team kept in memory (`resetFor` empties it
    // for another team): an id sessionStorage never took must survive the join.
    pending = mergePending(readPending(teamCode), pending);
    // An earlier screen kept texts with PII: they leave memory and sessionStorage before use.
    savePending(teamCode, forgetPiiPending(pending));
    const ids = pendingQueryIds(pending);
    const fetched = await fetchChat(teamCode, ids.length > 0 ? ids : undefined);
    loading = false;
    if (fetched !== null) savePending(teamCode, reconcilePending(pending, fetched.commands));
  };

  const addNotice = (target: string, text: string): void => {
    noticeSeq += 1;
    const notice = { id: noticeSeq, threadId: target, text, after: messages.value.length };
    notices.value = [...notices.value, notice];
  };

  const sendContext = (): SendContext | null => {
    const text = draft.value.trim();
    const teamCode = session.teamCode.value;
    const generation = session.generation.value;
    const target = threadId.value;
    if (text === "" || mode.value !== "live" || !writable()) return null;
    if (teamCode === null || generation === null || target === null) return null;
    const join = session.currentJoin();
    const key = pendingKey(target, text);
    return {
      teamCode,
      generation,
      join,
      threadId: target,
      text,
      key,
      pii: detectPii(text) !== null,
    };
  };

  /**
   * The join the send left in is still the one on screen. A join, even of the same team with the
   * same generation, is a new session: an answer to an older one is dropped whole (its
   * stale-generation, its snapshot, its notice and its text say nothing about the screen now).
   */
  const isCurrentSend = (context: SendContext): boolean => session.currentJoin() === context.join;

  /** The answer came: settle the id and fetch what the outcome says changed. */
  const settle = async (context: SendContext, outcome: ChatSendOutcome): Promise<void> => {
    if (!isCurrentSend(context)) return;
    const { teamCode } = context;
    const followUp = chatSendFollowUp(outcome);
    if (!followUp.keepCommandId) savePending(teamCode, forgetPending(pending, context.key));
    if (outcome.kind === "ok") {
      snapshot.value = newerSnapshot(snapshot.value, outcome.result.snapshot);
    }
    if (outcome.kind === "stale") session.markStale();
    if (followUp.refetch === "chat") await fetchChat(teamCode);
    // A text with PII: the Worker may have sprung Stage 5's trap on any answer, even a lost one.
    if (followUp.refetch === "game" || context.pii) await session.refresh();
  };

  /**
   * Then the pane: a failed send gives its text back and says why. A text for a stage the team
   * has left is not put into the next stage's input.
   */
  const report = (context: SendContext, outcome: ChatSendOutcome): void => {
    inFlight.value = null;
    const stillHere = isCurrentSend(context) && threadId.value === context.threadId;
    if (!stillHere) return;
    if (outcome.kind !== "ok") draft.value = context.text;
    const notice = chatNoticeText(outcome);
    if (notice !== null) addNotice(context.threadId, notice);
    if (outcome.kind === "unsaved" && outcome.reason === "pii-blocked") piiBlocks.value += 1;
  };

  /**
   * A text with PII gets a fresh id every time: its key (which holds the text) is never kept,
   * and one kept for the same text before is dropped, not reused.
   */
  const commandIdFor = (context: SendContext): string => {
    if (context.pii) {
      savePending(context.teamCode, forgetPending(pending, context.key));
      return deps.ids.next();
    }
    const given = pendingIdFor(pending, context.key, () => deps.ids.next());
    savePending(context.teamCode, given.pending);
    return given.commandId;
  };

  const send = async (): Promise<void> => {
    if (sending.value) return;
    const context = sendContext();
    if (context === null) return;
    sending.value = true;
    draft.value = "";
    inFlight.value = context.pii ? null : { threadId: context.threadId, text: context.text };
    try {
      const result = await deps.api.sendStageMessage(context.teamCode, {
        type: "stage-message",
        commandId: commandIdFor(context),
        generation: context.generation,
        text: context.text,
      });
      const outcome = classifyChatSend(result, context.text);
      await settle(context, outcome);
      report(context, outcome);
    } finally {
      sending.value = false;
    }
  };

  const retryPrepare = async (): Promise<void> => {
    if (preparing.value || !writable()) return;
    preparing.value = true;
    try {
      await session.prepareStageThread();
    } finally {
      preparing.value = false;
    }
  };

  /** Starts the pane over for a join. The unconfirmed ids go only when the team changes. */
  const resetFor = (join: number, teamCode: TeamCode | null): void => {
    loadedJoin = join;
    snapshot.value = null;
    notices.value = [];
    inFlight.value = null;
    draft.value = "";
    if (teamCode !== pendingTeam) pending = new Map();
    pendingTeam = teamCode;
  };

  scope.run(() => {
    // Every join is a new session, even of the same team with the same generation: the pane
    // starts over and fetches the chat and the unconfirmed ids again. A join sets the status
    // to `joining` and back to `ready`, so watching the status sees each one.
    watch(
      [session.status, session.teamCode],
      ([status, teamCode]) => {
        const join = session.currentJoin();
        if (join === loadedJoin || (status !== "ready" && teamCode !== null)) return;
        resetFor(join, teamCode);
        if (teamCode !== null && join !== 0) void load(teamCode);
      },
      { immediate: true },
    );
    // A new stage: the previous stage's notices, the message still on its way and the text half
    // written for the previous stage's AI leave the pane (sent now, it would go to another AI).
    // The new thread is fetched if the chat on screen does not have it yet.
    watch(threadId, (next) => {
      notices.value = [];
      inFlight.value = null;
      draft.value = "";
      const teamCode = session.teamCode.value;
      // Entering: `load` fetches the chat (it may start after this, in the same tick).
      if (next === null || teamCode === null || session.currentJoin() !== loadedJoin || loading)
        return;
      const known = snapshot.value?.threads.some((thread) => thread.threadId === next) ?? false;
      if (!known) void fetchChat(teamCode);
    });
  });

  return {
    mode,
    items,
    draft,
    sending: computed(() => sending.value),
    preparing: computed(() => preparing.value),
    piiBlocks: readonly(piiBlocks),
    send,
    retryPrepare,
    dispose: () => {
      scope.stop();
    },
  };
};
