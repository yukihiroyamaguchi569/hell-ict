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

/**
 * OpenAIのエラー応答（`{ error: { code, type, message } }`）から記録してよい識別子だけを
 * 取り出す。`message`は受け取らない——自由文で、送ったプロンプトやキーの一部が
 * 混ざりうるため。`code`・`type`もOpenAIの識別子の書式（英小文字で始まる英小文字・
 * 数字・`_`の64文字まで。`insufficient_quota`・`rate_limit_exceeded`など）に限る。
 * `-`と大文字を許さないので、`sk-`で始まるAPIキーや文章の断片はこの書式に収まらない。
 * 外れた値は本文全体を捨てずにその項目だけを落とす（正規の値を他方の異常値の
 * 巻き添えにしない）。
 */
const openAiErrorTokenSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .nullable()
  .optional()
  .catch(undefined);

export const openAiErrorBodySchema = z.object({
  error: z.object({
    code: openAiErrorTokenSchema,
    type: openAiErrorTokenSchema,
  }),
});

export type OpenAiErrorIdentifiers = {
  readonly code: string | null;
  readonly type: string | null;
};

/** エラー応答の形でなければ両方nullを返す。記録の補助なので例外は投げない。 */
export const parseOpenAiErrorBody = (input: unknown): OpenAiErrorIdentifiers => {
  const parsed = openAiErrorBodySchema.safeParse(input);
  if (!parsed.success) return { code: null, type: null };
  return { code: parsed.data.error.code ?? null, type: parsed.data.error.type ?? null };
};
