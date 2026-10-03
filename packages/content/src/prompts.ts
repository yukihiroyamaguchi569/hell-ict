import type { SystemPrompts } from "./schemas.js";

/*
 * worker が注入する system prompt（ダミーシナリオ。罠は仕込まない）。index.ts からは export しない——
 * web が `@hell-ict/content` を import してもバンドルに入らないよう、`@hell-ict/content/prompts`
 * からだけ読める（eslint の no-restricted-imports が web と domain からの import を禁じる）。
 */

export const systemPrompts = {
  default:
    "あなたは聖クロノス総合病院のスタッフが業務に使うAIアシスタントです。日本語で、簡潔かつ具体的に答えてください。",
  s1: "あなたは聖クロノス総合病院のスタッフが業務に使うAIアシスタントです。院内メールの返信下書きを頼まれたら、丁寧なビジネスメールを日本語で作成してください。",
  s3: "あなたは聖クロノス総合病院のスタッフが業務に使うAIアシスタントです。感染対策の質問には、日本語で簡潔に答えてください。",
} as const satisfies SystemPrompts;
