import type { ChatSnapshot } from "@hell-ict/domain";
import { useRef, useState } from "react";

import { HttpRequestError } from "./http-client.js";

type ChatPaneProps = {
  snapshot: ChatSnapshot | null;
  onCreateThread: (commandId: string, title: string) => Promise<void>;
  onSendMessage: (commandId: string, threadId: string, text: string) => Promise<void>;
};

type PendingSend = { commandId: string; threadId: string; text: string };

/**
 * 送信前ゲート（beginChatMessageを呼ぶ前）でのブロックか判定する。このときだけ
 * 何も保存されていないため、pendingを解除して新しいcommandIdで書き直せる。
 * AIポリシー拒否・履歴中PIIのブロックは既にユーザーメッセージが保存済みなので
 * 対象にしない——同じcommandIdでの再試行に倒し、二重保存を防ぐ。
 * sendの複雑度を下げるための切り出し。
 */
const isPreSendBlock = (caught: unknown): boolean =>
  caught instanceof HttpRequestError && caught.code === "pii_blocked";

/** 送信失敗時の表示文言を組み立てる。sendの複雑度を下げるための切り出し。 */
const sendFailureMessage = (caught: unknown): string =>
  caught instanceof HttpRequestError
    ? caught.message
    : "送信に失敗しました。もう一度押すと同じ内容を安全に再試行します。";

/**
 * P1Cの最小チャットペイン。判定・永続化は持たず、送信とスレッド切り替えの
 * 素の表示だけを担う。見た目は docs/ui/00_共通シェルと通奏低音.md §8 でP2以降に作る。
 */
export const ChatPane = ({ snapshot, onCreateThread, onSendMessage }: ChatPaneProps) => {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  // 送信中〜再試行完了までは{commandId, threadId, text}を丸ごと固定する。
  // これが無いと、失敗後にthreadIdやtextを変えてから再試行したとき、
  // 同じcommandIdで別内容を送ってしまい冪等性の前提が壊れる。
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [creatingThread, setCreatingThread] = useState(false);
  const createCommandId = useRef<string | null>(null);

  if (snapshot === null) return null;
  const { threads } = snapshot;
  const currentThreadId = activeThreadId ?? threads[0]?.threadId ?? null;
  const currentThread = threads.find((thread) => thread.threadId === currentThreadId) ?? null;

  const send = async (): Promise<void> => {
    if (sending) return;
    const payload: PendingSend | null =
      pending ??
      (currentThreadId !== null && text.trim() !== ""
        ? { commandId: crypto.randomUUID(), threadId: currentThreadId, text }
        : null);
    if (payload === null) return;
    setPending(payload);
    setSending(true);
    try {
      await onSendMessage(payload.commandId, payload.threadId, payload.text);
      setPending(null);
      setText("");
      setStatus("");
    } catch (caught) {
      // 送信前ゲートでのブロックだけは何も保存されていないため、入力欄を再び
      // 有効にして書き直せるようにする。それ以外の失敗はpendingを保持し、
      // 同じcommandIdでの再試行に倒す（新しいcommandIdだと二重保存になる）。
      if (isPreSendBlock(caught)) setPending(null);
      setStatus(sendFailureMessage(caught));
    } finally {
      setSending(false);
    }
  };

  const createThread = async (): Promise<void> => {
    if (creatingThread) return;
    createCommandId.current ??= crypto.randomUUID();
    setCreatingThread(true);
    try {
      await onCreateThread(createCommandId.current, `スレッド${String(threads.length + 1)}`);
      createCommandId.current = null;
    } catch {
      setStatus("スレッドの作成に失敗しました。もう一度お試しください。");
    } finally {
      setCreatingThread(false);
    }
  };

  // 送信中〜再試行待ちの間は、スレッド切り替え・入力・二重送信を止める。
  // 送信ボタンだけは「送信中」でなければ有効にし、pendingが残っていれば
  // その内容そのままを再送できるようにする。
  const controlsDisabled = sending || pending !== null;

  return (
    <aside>
      <h2>AIチャット</h2>
      <nav>
        {threads.map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            aria-pressed={thread.threadId === currentThreadId}
            disabled={controlsDisabled}
            onClick={() => {
              setActiveThreadId(thread.threadId);
            }}
          >
            {thread.title}
          </button>
        ))}
        <button
          type="button"
          aria-label="スレッドを作成"
          disabled={creatingThread}
          onClick={() => {
            void createThread();
          }}
        >
          ＋
        </button>
      </nav>
      <ul>
        {currentThread?.messages.map((message) => (
          <li key={message.messageId}>
            <strong>{message.role === "user" ? "あなた" : "AI"}: </strong>
            {message.text}
          </li>
        ))}
      </ul>
      <label htmlFor="chat-message">メッセージ</label>
      <textarea
        id="chat-message"
        value={text}
        disabled={controlsDisabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button
        type="button"
        disabled={sending}
        onClick={() => {
          void send();
        }}
      >
        送信
      </button>
      <p role="status">{status}</p>
    </aside>
  );
};
