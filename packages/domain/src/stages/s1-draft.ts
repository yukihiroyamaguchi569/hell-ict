import { stage1MailsRound1, stage1MailsRound2, stage1MailsRound3 } from "@hell-ict/content";

import { CHAT_MESSAGE_MAX_CHARS } from "../schemas/chat.js";
import type { Stage1MailId } from "./s1.js";

/**
 * The request the server sends to the AI for [AIに下書きさせる] (the mock's `s1BuildDraftText`).
 * The server builds it from the mail it knows by id, so the screen sends only the mail id, the
 * context box and the key points (Issue #236: the AI is bound to the stage on the server).
 *
 * Order: the context (only when the gate accepted it as the source), the mail (sender, subject,
 * body), the key points (when written). Only the context is cut to fit the chat message ceiling:
 * the mail and the key points are short, the pasted handover memo is what grows.
 */

const STAGE1_MAILS = [...stage1MailsRound1, ...stage1MailsRound2, ...stage1MailsRound3];

const HEAD = "次の院内メールへの返信を下書きしてください。\n\n";
const CONTEXT_PREFIX = "【参考資料】\n";

export interface Stage1DraftInput {
  context: string;
  point: string;
}

/**
 * `useContext` is the draft gate's `source === "context"` (judgeStage1DraftRequest). `null`
 * when the id is not a mail of Stage 1 (the gate has already refused such an id).
 */
export const buildStage1DraftText = (
  mailId: Stage1MailId,
  input: Stage1DraftInput,
  useContext: boolean,
): string | null => {
  const mail = STAGE1_MAILS.find((candidate) => candidate.id === mailId);
  if (mail === undefined) return null;
  const mailBlock = `【受信メール】\n差出人: ${mail.from}\n件名: ${mail.subj}\n本文:\n${mail.body.join("\n")}`;
  const point = input.point.trim();
  const pointBlock = point === "" ? "" : `\n\n【要点】\n${point}`;
  if (!useContext) return HEAD + mailBlock + pointBlock;
  const tail = `\n\n${mailBlock}${pointBlock}`;
  const budget = Math.max(
    0,
    CHAT_MESSAGE_MAX_CHARS - HEAD.length - CONTEXT_PREFIX.length - tail.length,
  );
  const context = input.context.trim().slice(0, budget);
  return HEAD + CONTEXT_PREFIX + context + tail;
};
