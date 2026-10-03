import type { ChatMessage } from "@hell-ict/domain";

/*
 * The bubbles of the AI pane, in order. Pure: ChatPane draws what `chatPaneItems` returns.
 */

/**
 * A system bubble (a send that failed, a rate limit …). It belongs to the thread it was said
 * in, and stands after the first `after` messages of that thread: a refetch that brings more
 * messages (the saved user message of a refusal) keeps it where it was said.
 */
export interface ChatNotice {
  readonly id: number;
  readonly threadId: string;
  readonly text: string;
  readonly after: number;
}

/** The message on its way to the AI: shown as the team's bubble and 「AIが入力中…」. */
export interface InFlightMessage {
  readonly threadId: string;
  readonly text: string;
}

export type ChatPaneItem =
  /** The AI's greeting (mock AI_GREETING_HTML): only while nothing else is in the pane. */
  | { readonly kind: "greeting"; readonly key: string }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly role: ChatMessage["role"];
      readonly text: string;
    }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | { readonly kind: "typing"; readonly key: string }
  /**
   * A scripted turn's own words for the wait, instead of 「AIが入力中…」 (`waitingText`), with a
   * bar that fills in `progressMs` when the turn has one (`waitingMs`).
   */
  | {
      readonly kind: "waiting";
      readonly key: string;
      readonly text: string;
      readonly progressMs?: number;
    }
  /** An answer the stage made on the screen (mock `aiBubble(..., { scripted: true })`). */
  | {
      readonly kind: "scripted";
      readonly key: string;
      readonly text: string;
      readonly action: ChatReplyAction | null;
      readonly image?: ChatReplyImage;
    };

/** A button under a scripted answer's lead (Stage 2's ［表に送る］). */
export interface ChatReplyAction {
  readonly label: string;
  run(): void;
}

/** A picture in a scripted answer (Stage 6's poster). `alt` also stands in if it fails to load. */
export interface ChatReplyImage {
  readonly src: string;
  readonly alt: string;
}

/**
 * What a stage answers on the screen (`StageInstance.chatSubmit` or `StageInstance.chat`): never
 * sent to the AI.
 */
export interface ChatReply {
  readonly text: string;
  readonly action?: ChatReplyAction;
  readonly image?: ChatReplyImage;
}

/** A message the stage answers on the screen; `reply` is `null` while it waits. */
export interface ScriptedTurn {
  readonly id: number;
  readonly text: string;
  readonly reply: ChatReply | null;
  /** What the wait says instead of 「AIが入力中…」 (Stage 6's 「画像を生成しています…」). */
  readonly waitingText?: string;
  /** How long the wait's bar takes to fill (Stage 6's 2.5 s, mock `.s6-wait .bar`). No bar without. */
  readonly waitingMs?: number;
}

const messageItem = (message: ChatMessage): ChatPaneItem => ({
  kind: "message",
  key: message.messageId,
  role: message.role,
  text: message.text,
});

const noticeItem = (notice: ChatNotice): ChatPaneItem => ({
  kind: "notice",
  key: `notice-${String(notice.id)}`,
  text: notice.text,
});

/**
 * `messages` are the current thread's (`stageThreadMessages`); `threadId` is that thread, or
 * `null` when the stage has none. Notices and the message in flight of any other thread are
 * left out: they belong to a stage the team has left.
 */
export const chatPaneItems = (
  messages: readonly ChatMessage[],
  notices: readonly ChatNotice[],
  inFlight: InFlightMessage | null,
  threadId: string | null,
): readonly ChatPaneItem[] => {
  const own = notices.filter((notice) => notice.threadId === threadId);
  const noticesAt = (index: number): ChatPaneItem[] =>
    own.filter((notice) => notice.after === index).map(noticeItem);
  const items: ChatPaneItem[] = messages.flatMap((message, index) => [
    ...noticesAt(index),
    messageItem(message),
  ]);
  items.push(...own.filter((notice) => notice.after >= messages.length).map(noticeItem));
  if (inFlight !== null && inFlight.threadId === threadId) {
    items.push(
      { kind: "message", key: "in-flight", role: "user", text: inFlight.text },
      { kind: "typing", key: "typing" },
    );
  }
  return items.length === 0 ? [{ kind: "greeting", key: "greeting" }] : items;
};

/**
 * The pane with the scripted turns after the server's bubbles. They live on this screen only (a
 * reload is back to the greeting, user decision 9), and the greeting goes with the first one.
 */
export const withScriptedTurns = (
  items: readonly ChatPaneItem[],
  turns: readonly ScriptedTurn[],
): readonly ChatPaneItem[] => {
  if (turns.length === 0) return items;
  const own = turns.flatMap((turn): ChatPaneItem[] => {
    const key = `scripted-${String(turn.id)}`;
    const mine: ChatPaneItem = { kind: "message", key: `${key}-me`, role: "user", text: turn.text };
    if (turn.reply === null) {
      const progress = turn.waitingMs === undefined ? {} : { progressMs: turn.waitingMs };
      const waiting: ChatPaneItem =
        turn.waitingText === undefined
          ? { kind: "typing", key: `${key}-typing` }
          : { kind: "waiting", key: `${key}-typing`, text: turn.waitingText, ...progress };
      return [mine, waiting];
    }
    const { text, action, image } = turn.reply;
    const picture = image === undefined ? {} : { image };
    return [mine, { kind: "scripted", key, text, action: action ?? null, ...picture }];
  });
  return [...items.filter((item) => item.kind !== "greeting"), ...own];
};
