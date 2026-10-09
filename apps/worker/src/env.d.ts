export {};

/**
 * OPENAI_API_KEYは秘匿情報のため、wrangler.jsonc の `vars`（Cloudflareダッシュボードに
 * 平文表示される）には置かない。ローカルは `.dev.vars`（.gitignore済み）、
 * 本番は `wrangler secret put OPENAI_API_KEY` で供給する。
 *
 * このファイルは `wrangler types` の生成物（worker-configuration.d.ts）ではなく、
 * 手書きでglobalな`Env`型へ追加する。`worker-configuration.d.ts`のトップレベル
 * `interface Env`はグローバルスコープの宣言であり、TypeScriptは同名の
 * グローバルinterfaceをファイルをまたいでmergeするため、`vars`に無くても
 * `env.OPENAI_API_KEY`が`string`として型付けされる。
 */

/**
 * ALLOWED_ORIGINS / TEAM_MAX / CHAT_RATE_LIMIT_PER_MINUTEは、秘匿情報ではないが
 * 会ごとに変わる運用値なので`wrangler.jsonc`の`vars`へ値を書かず、デプロイ前に
 * `wrangler secret put`で与える（未設定でも既定動作で動く）。ダッシュボードの
 * Variablesと`wrangler deploy --var`は、デプロイのたびに消えるので使わない。
 * 未設定を型で表すため`string | undefined`とし、guard.tsのパーサが既定へ倒す。
 */
/**
 * ADMIN_TOKENは、ゲームマスター専用のリセットAPI（`POST /api/gm/teams/.../reset`）の
 * 唯一の資格情報である。総当たりを現実的でなくするため32文字以上を推奨し、
 * `wrangler secret put ADMIN_TOKEN`で与える。未設定ならGM系ルートは常に404を返し、
 * 設定漏れのまま誰でもリセットできる状態にはならない（fail-closed）。
 */
/**
 * OPENAI_API_KEY_BACKUPとOPENAI_MODEL_BACKUPは予備の経路（src/ai-failover.ts）。
 * 予備キーは別の組織・プロジェクトのキーで、OPENAI_API_KEYと同じく秘匿情報なので
 * `wrangler secret put`で与える。予備モデルは秘密ではないが、会ごとの運用値として
 * 同じく`wrangler secret put`で与える。どちらも未設定（空文字を含む）なら予備なしで動く。
 */
/**
 * AI_ROUTEとAI_FALLBACK_*は、OpenAIそのものが落ちたときに手で切り替える他社の予備
 * （src/ai-failover.ts）。予備の接続先・キー・モデルを本番前に`wrangler secret put`で
 * 登録しておき、障害時は`AI_ROUTE`に`fallback`を入れるだけで切り替える（デプロイ不要）。
 * 切り替えのたびにデプロイで消えないよう、どれも`vars`ではなくsecretで与える。
 * 未設定・空・`primary`・書き損じ、予備の3つの不足、httpsでない接続先では主系のまま動く。
 */
declare global {
  interface HellIctVars {
    OPENAI_API_KEY: string;
    OPENAI_API_KEY_BACKUP?: string;
    OPENAI_MODEL_BACKUP?: string;
    AI_ROUTE?: string;
    AI_FALLBACK_BASE_URL?: string;
    AI_FALLBACK_API_KEY?: string;
    AI_FALLBACK_MODEL?: string;
    ADMIN_TOKEN?: string;
    EVENT_NO?: string;
    ALLOWED_ORIGINS?: string;
    TEAM_MAX?: string;
    CHAT_RATE_LIMIT_PER_MINUTE?: string;
  }

  // 中身が空のinterfaceでの拡張は、宣言マージで既存の型へ項目を足すための
  // 唯一の書き方である（型エイリアスではマージできない）。定義を1か所に保つため、
  // ここだけ no-empty-object-type を外す。
  /* eslint-disable @typescript-eslint/no-empty-object-type -- empty interfaces merge HellIctVars into Env */
  interface Env extends HellIctVars {}

  /**
   * `wrangler types`が生成する`Cloudflare.Env`へも同じ項目を足す。テストが
   * `import { env } from "cloudflare:workers"`で受け取る値はこちらの型で、
   * グローバルな`Env`とは別物のため、片方だけではテスト側が型エラーになる。
   */
  namespace Cloudflare {
    interface Env extends HellIctVars {}
  }
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}
