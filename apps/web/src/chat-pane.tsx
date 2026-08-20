import type { ChatSnapshot } from "@hell-ict/domain";
import { useRef, useState } from "react";

type ChatPaneProps = {
  snapshot: ChatSnapshot | null;
  onCreateThread: (commandId: string, title: string) => Promise<void>;
  onSendMessage: (commandId: string, threadId: string, text: string) => Promise<void>;
};

/**
 * P1Cの最小チャットペイン。判定・永続化は持たず、送信とスレッド切り替えの
 * 素の表示だけを担う。見た目は docs/ui/00_共通シェルと通奏低音.md §8 でP2以降に作る。
 */
export const ChatPane = ({ snapshot, onCreateThread, onSendMessage }: ChatPaneProps) => {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const sendCommandId = useRef<string | null>(null);
  const createCommandId = useRef<string | null>(null);

  if (snapshot === null) return null;
  const { threads } = snapshot;
  const currentThreadId = activeThreadId ?? threads[0]?.threadId ?? null;
  const currentThread = threads.find((thread) => thread.threadId === currentThreadId) ?? null;

  const send = async (): Promise<void> => {
    if (currentThreadId === null || text.trim() === "") return;
    sendCommandId.current ??= crypto.randomUUID();
    try {
      await onSendMessage(sendCommandId.current, currentThreadId, text);
      sendCommandId.current = null;
      setText("");
      setStatus("");
    } catch {
      setStatus("送信に失敗しました。もう一度押すと同じ操作を安全に再試行します。");
    }
  };

  const createThread = async (): Promise<void> => {
    createCommandId.current ??= crypto.randomUUID();
    try {
      await onCreateThread(createCommandId.current, `スレッド${String(threads.length + 1)}`);
      createCommandId.current = null;
    } catch {
      setStatus("スレッドの作成に失敗しました。もう一度お試しください。");
    }
  };

  return (
    <aside>
      <h2>AIチャット</h2>
      <nav>
        {threads.map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            aria-pressed={thread.threadId === currentThreadId}
            onClick={() => {
              setActiveThreadId(thread.threadId);
            }}
          >
            {thread.title}
          </button>
        ))}
        <button
          type="button"
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
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button
        type="button"
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
