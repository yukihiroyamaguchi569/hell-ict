import { z } from "zod";

/** Workerのerror()（apps/worker/src/http.ts）が返すJSON本文の形。 */
export const httpErrorSchema = z.object({ message: z.string() }).strict();

export type HttpError = z.infer<typeof httpErrorSchema>;
