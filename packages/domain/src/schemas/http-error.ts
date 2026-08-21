import { z } from "zod";

/**
 * `code`は、クライアントが再試行方針を機械的に判断するための識別子。
 * `pii_blocked`は送信前ゲート（beginChatMessageを呼ぶ前）でのブロックのみに付ける——
 * このときは何も保存されていないため、新しいcommandIdで書き直してよい。
 * それ以外の422（AIポリシー拒否・履歴中PIIのブロック）はcodeを持たず、
 * 既にユーザーメッセージが保存済みなので同じcommandIdでの再試行に倒す。
 */
export const httpErrorCodeSchema = z.enum(["pii_blocked"]);

/** Workerのerror()（apps/worker/src/http.ts）が返すJSON本文の形。 */
export const httpErrorSchema = z
  .object({ message: z.string(), code: httpErrorCodeSchema.optional() })
  .strict();

export type HttpErrorCode = z.infer<typeof httpErrorCodeSchema>;
export type HttpError = z.infer<typeof httpErrorSchema>;
