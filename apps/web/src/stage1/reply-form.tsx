import type { Stage1EmailId } from "@hell-ict/domain";
import { useEffect, useState } from "react";

import type { Stage1EmailView } from "./email-view.js";

type ReplyFormProps = {
  view: Stage1EmailView | null;
  onSubmit: (emailId: Stage1EmailId, text: string) => Promise<void>;
};

const EMPTY_WARNING_MS = 1_600;

/**
 * 中央ペイン：読んで、打つ（docs/ui/02_Stage1.md §2）。返信欄は空、定型文もテンプレートも
 * 置かない。止めるのは空送信だけ——失礼な返信も送れてしまい、判定はラウンド終了時に返ってくる。
 */
export const ReplyForm = ({ view, onSubmit }: ReplyFormProps) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [warning, setWarning] = useState("");
  const selectedEmailId = view?.email.id ?? null;

  useEffect(() => {
    setText("");
    setWarning("");
  }, [selectedEmailId]);

  if (view === null) {
    return <p className="reply-form__empty">受信トレイからメールを選んでください。</p>;
  }

  const disabled = sending || view.status !== "pending";

  const send = async (): Promise<void> => {
    if (text.trim() === "") {
      setWarning("本文が空です");
      window.setTimeout(() => {
        setWarning("");
      }, EMPTY_WARNING_MS);
      return;
    }
    setSending(true);
    try {
      await onSubmit(view.email.id, text);
      setText("");
    } catch {
      setWarning("送信に失敗しました。もう一度押すと同じ内容を安全に再試行します。");
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="reply-form">
      <h3>{view.email.subject}</h3>
      <p className="reply-form__from">{view.email.from}</p>
      {view.email.body.map((paragraph, index) => (
        <p key={index} className="prose">
          {paragraph}
        </p>
      ))}
      <label htmlFor="stage1-reply">返信</label>
      <textarea
        id="stage1-reply"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void send();
        }}
      >
        {warning || "送信する"}
      </button>
    </article>
  );
};
