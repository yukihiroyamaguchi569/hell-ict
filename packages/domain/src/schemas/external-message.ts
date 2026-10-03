import { z } from "zod";

export const externalMessageSchema = z.object({
  message: z.string().trim().min(1).max(280),
});

export type ExternalMessage = z.infer<typeof externalMessageSchema>;

export const parseExternalMessage = (input: unknown): ExternalMessage =>
  externalMessageSchema.parse(input);
