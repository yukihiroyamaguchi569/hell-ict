import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // EVENT_NOはここで注入しない。未設定のfail-open（6桁なら何でも通る）を
      // 前提にしたテストが多く、既定で入れると入室・進捗・healthのテストが総崩れになる。
      // 開催回が要るテスト（活動ログのevent_id）は、そのテストの中でenvを差し替える。
      wrangler: { configPath: "./wrangler.jsonc" },
      // wrangler.jsoncと同じ階層の.dev.varsも読み込まれるため、ローカルに実キーがあると
      // テストが本物のOpenAIへ送信してしまう。.dev.varsの有無にかかわらず、キーはダミー、
      // 宛先は到達しないループバック（discardポート）で上書きする（Issue #252）。
      // miniflareの指定はwrangler由来の設定より後にマージされ、同名のbindingを上書きする。
      miniflare: {
        bindings: {
          OPENAI_API_KEY: "test-dummy-openai-key",
          OPENAI_BASE_URL: "http://127.0.0.1:9",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
