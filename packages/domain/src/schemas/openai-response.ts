import { z } from "zod";

/**
 * OpenAI Chat Completions APIの応答から、このアプリが使う部分だけを検証する。
 * 未知フィールドはOpenAI側の仕様追加で増えうるため、ここでは`.strict()`にしない。
 */
export const openAiChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().min(1),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export type OpenAiChatCompletion = z.infer<typeof openAiChatCompletionSchema>;

export const parseOpenAiChatCompletion = (input: unknown): OpenAiChatCompletion =>
  openAiChatCompletionSchema.parse(input);
