import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // EVENT_IDはsecretで与える運用（理由はwrangler.jsonc）。wrangler.jsoncの
      // varsに無いので、テストでは本番のsecretに相当する値をここで注入する。
      miniflare: { bindings: { EVENT_ID: "dev" } },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
