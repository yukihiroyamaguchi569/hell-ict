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
          // ポリシー拒否時、OpenAIは content: null かつ refusal に理由を返す。
          // content必須にすると正当な拒否応答がただのparse失敗になり、
          // 原因不明のまま扱われてしまう。
          content: z.string().min(1).nullable(),
          refusal: z.string().min(1).nullable().optional(),
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
