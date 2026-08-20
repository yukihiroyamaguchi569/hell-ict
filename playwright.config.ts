import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 既存プロセスを再利用すると、OPENAI_BASE_URLがスタブを指さない
      // 素のWorker/実キー経路へE2Eが無言で迂回しうる。常に起動し直す。
      name: "openai-stub",
      command: "node e2e/openai-stub.mjs",
      url: "http://127.0.0.1:8789/health",
      reuseExistingServer: false,
    },
    {
      name: "worker",
      command:
        "pnpm --filter @hell-ict/worker exec wrangler dev --local --ip 127.0.0.1 --port 8787 --var OPENAI_BASE_URL:http://127.0.0.1:8789",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
    },
    {
      name: "web",
      command: "pnpm --filter @hell-ict/web dev --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
