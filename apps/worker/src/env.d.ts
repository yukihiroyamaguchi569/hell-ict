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
declare global {
  interface Env {
    OPENAI_API_KEY: string;
    EVENT_ID?: string;
  }
}
