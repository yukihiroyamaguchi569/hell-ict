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
 */
export const httpErrorCodeSchema = z.enum([
  "pii_blocked",
  "history_pii",
  "ai_refusal",
  ...CHECKPOINT_REJECTION_REASONS,
]);

/** Workerのerror()（apps/worker/src/http.ts）が返すJSON本文の形。 */
export const httpErrorSchema = z
  .object({ message: z.string(), code: httpErrorCodeSchema.optional() })
  .strict();

export type HttpErrorCode = z.infer<typeof httpErrorCodeSchema>;
export type HttpError = z.infer<typeof httpErrorSchema>;
