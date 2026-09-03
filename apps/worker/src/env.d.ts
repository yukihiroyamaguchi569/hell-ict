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
 * ALLOWED_ORIGINS / TEAM_CODESは、秘匿情報ではないが会ごとに変わる運用値なので
 * `wrangler.jsonc`の`vars`へ値を書かず、デプロイ前にダッシュボードまたは
 * `wrangler deploy --var`で与える（未設定でも既定動作で動く）。
 * 未設定を型で表すため`string | undefined`とし、guard.tsのパーサが既定へ倒す。
 */
declare global {
  interface Env {
    OPENAI_API_KEY: string;
    ALLOWED_ORIGINS?: string;
    TEAM_CODES?: string;
  }
}
