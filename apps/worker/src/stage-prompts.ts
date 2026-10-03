import { systemPrompts } from "@hell-ict/content/prompts";
import type { PromptProfile } from "@hell-ict/domain";

// プロンプトの本文はシナリオ（content の systemPrompts）が持つ。
// テーブル方式にすることで、将来PromptProfileへ値を追加したときに
// `satisfies Record<PromptProfile, string>`がコンパイルエラーで検知する
// （if連鎖のフォールスルーで罠が無言でdefaultへ落ちるのを防ぐ）。
const PROMPTS = systemPrompts satisfies Record<PromptProfile, string>;

/**
 * `promptProfile`（未指定は"default"扱い）からシステムプロンプト文字列を返す。
 * ステージ別の罠・ガードレールをWorker側で確実に注入するための純関数。
 */
export const systemPromptFor = (promptProfile: PromptProfile | undefined): string =>
  PROMPTS[promptProfile ?? "default"];
