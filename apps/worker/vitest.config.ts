import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // EVENT_NOはここで注入しない。未設定のfail-open（6桁なら何でも通る）を
      // 前提にしたテストが多く、既定で入れると入室・進捗・healthのテストが総崩れになる。
      // 開催回が要るテスト（活動ログのevent_id）は、そのテストの中でenvを差し替える。
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
