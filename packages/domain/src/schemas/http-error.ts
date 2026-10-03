import { z } from "zod";

import { CHECKPOINT_REJECTION_REASONS } from "./checkpoint.js";

/**
 * `code`は、クライアントが再試行方針を機械的に判断するための識別子。
 * 422は3種あり、どれも「保存済みか否か」と「再送してよいか」が違うので、codeで区別する。
 * - `pii_blocked`: 送信前ゲート（beginChatMessageを呼ぶ前）でのブロック。何も保存されて
 *   いないので、新しいcommandIdで書き直してよい。
 * - `history_pii`: 会話履歴中のPIIによるブロック。ユーザー発言は保存済みで、pendingの
 *   クレームだけ解放してある。同じcommandIdでの再試行に倒す。
 * - `ai_refusal`: AIのポリシー拒否。こちらもユーザー発言は保存済み。再試行しても
 *   同じ本文なら結果は変わらないので、本文を書き換えたうえで送り直す。
 *
 * チェックポイント保存の409は`CHECKPOINT_REJECTION_REASONS`をそのままcodeに載せる——
 * 4種の拒否をクライアントが文言ではなく値で判別し、conflictなら取り直して再送、
 * *-regressionなら巻き戻した状態を送り直さない、と分岐できるようにする。
 *
 * ステージに結び付いたAIチャット（Issue #236）の409。どれも何も保存していない。
 * - `no_ai_chat`: 今のステージにはその送信を受けるAIが無い（Stage 2・6の会話、Stage 1以外の下書き）。
 * - `thread_not_ready`: 今のステージの会話を用意できていない。前のステージの会話へは送らない
 *   （Issue #85）。画面は失敗を示し、会話の準備をやり直させる。
 * - `draft_rejected`: Stage 1の下書きの条件を満たさない。理由は`reason`に載る
 *   （judgeStage1DraftRequestの理由。未開始は`not-started`）。
 */
export const httpErrorCodeSchema = z.enum([
  "pii_blocked",
  "history_pii",
  "ai_refusal",
  "no_ai_chat",
  "thread_not_ready",
  "draft_rejected",
  ...CHECKPOINT_REJECTION_REASONS,
]);

/** Workerのerror()（apps/worker/src/http.ts）が返すJSON本文の形。 */
export const httpErrorSchema = z
  .object({
    message: z.string(),
    code: httpErrorCodeSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();

export type HttpErrorCode = z.infer<typeof httpErrorCodeSchema>;
export type HttpError = z.infer<typeof httpErrorSchema>;
