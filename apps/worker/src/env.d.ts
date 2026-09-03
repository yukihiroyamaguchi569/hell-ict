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
declare global {
  interface Env {
    OPENAI_API_KEY: string;
    /**
     * 活動ログ（activity_events.event_id）へ書く開催回の識別子。wrangler.jsoncの
     * `vars`にあるが、worker-configuration.d.tsを再生成せずに済ませたいので
     * ここへ手書きで足す（生成物は`wrangler types`の実行者ごとに差分が出るため）。
     */
    EVENT_ID: string;
  }
}
