import { defineConfig, devices } from "@playwright/test";

import { OPENAI_STUB_ORIGIN, WORKER_ORIGIN, WORKER_PORT } from "./e2e/ports";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: {
    // Vueアプリ（e2e/shell/）は本番と同じく、Workerが配る `/` を同一オリジンで開く。
    baseURL: WORKER_ORIGIN,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "on-first-retry",
  },
  projects: [
    // 高速レーン（pnpm verify）。`test:e2e` は --project=chromium なので、
    // journey はここに入らない。
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "journey/**" },
    // 監査レーン（pnpm verify:full / CIの `監査レーン` ラベル）。Prologueから
    // 感謝状までを1本で通すため、演出とタイマーのぶんテスト単位の制限時間を
    // 長く取る（chromiumの既定30秒では足りない）。
    {
      name: "journey",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "journey/**",
      timeout: 300_000,
    },
  ],
  webServer: [
    {
      // 既存プロセスを再利用すると、OPENAI_BASE_URLがスタブを指さない
      // 素のWorker/実キー経路へE2Eが無言で迂回しうる。常に起動し直す。
      name: "openai-stub",
      command: "node e2e/openai-stub.mjs",
      url: `${OPENAI_STUB_ORIGIN}/health`,
      reuseExistingServer: false,
    },
    {
      name: "worker",
      // Vueアプリ（`/`）はWorkerのAssets（apps/worker/public/）
      // から配られる。build:testplayを前段に置かないとpublic/が.gitkeepだけの空になり、
      // クリーンチェックアウトのCIでは配信物を一度も開かないまま緑になる。
      command: `bash scripts/build-testplay.sh && pnpm --filter @hell-ict/worker exec wrangler dev --local --ip 127.0.0.1 --port ${String(WORKER_PORT)} --var OPENAI_BASE_URL:${OPENAI_STUB_ORIGIN}`,
      url: `${WORKER_ORIGIN}/api/health`,
      reuseExistingServer: false,
      // wrangler dev の標準出力（1リクエスト1行）をCIログへ流す。wranglerが残す
      // ログファイルには、この行——どのチームがどのAPIをどの順で叩いたか——が入って
      // いない。2026-09-11に wrangler dev が落ちた原因テストを特定できたのはこの並び
      // からで、失敗時のログ出力（.github/workflows/verify.yml）と対で意味を持つ。
      stdout: "pipe",
    },
  ],
});
