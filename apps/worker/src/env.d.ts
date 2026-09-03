export {};

/**
 * OPENAI_API_KEYは秘匿情報のため、wrangler.jsonc の `vars`（Cloudflareダッシュボードに
 * 平文表示される）には置かない。ローカルは `.dev.vars`（.gitignore済み）、
 * 本番は `wrangler secret put OPENAI_API_KEY` で供給する。
 *
 * EVENT_ID（活動ログへ書く開催回の識別子）は秘匿情報ではないが、同じくsecretで与える。
 * `vars`へ置くと生成される型が値の文字列リテラルになり、開催回ごとに値を変えるたび
 * 生成物の再生成が要るため、型生成から切り離す（理由はwrangler.jsonc側にも記載）。
 * 未設定の環境がありうるのでoptionalとし、記録側で空文字へ倒す。
 *
 * このファイルは `wrangler types` の生成物（worker-configuration.d.ts）ではなく、
 * 手書きでglobalな`Env`型へ追加する。`worker-configuration.d.ts`のトップレベル
 * `interface Env`はグローバルスコープの宣言であり、TypeScriptは同名の
 * グローバルinterfaceをファイルをまたいでmergeするため、`vars`に無くても
 * `env.OPENAI_API_KEY`が`string`として型付けされる。
 */

/**
 * ALLOWED_ORIGINS / TEAM_CODES / CHAT_RATE_LIMIT_PER_MINUTEは、秘匿情報ではないが
 * 会ごとに変わる運用値なので`wrangler.jsonc`の`vars`へ値を書かず、デプロイ前に
 * ダッシュボードまたは`wrangler deploy --var`で与える（未設定でも既定動作で動く）。
 * 未設定を型で表すため`string | undefined`とし、guard.tsのパーサが既定へ倒す。
 */
declare global {
  interface HellIctVars {
    OPENAI_API_KEY: string;
    EVENT_ID?: string;
    ALLOWED_ORIGINS?: string;
    TEAM_CODES?: string;
    CHAT_RATE_LIMIT_PER_MINUTE?: string;
  }

  // 中身が空のinterfaceでの拡張は、宣言マージで既存の型へ項目を足すための
  // 唯一の書き方である（型エイリアスではマージできない）。定義を1か所に保つため、
  // ここだけ no-empty-object-type を外す。
  /* eslint-disable @typescript-eslint/no-empty-object-type */
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
