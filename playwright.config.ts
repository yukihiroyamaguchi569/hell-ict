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
      name: "openai-stub",
      command: "node e2e/openai-stub.mjs",
      url: "http://127.0.0.1:8789/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      name: "worker",
      command:
        "pnpm --filter @hell-ict/worker exec wrangler dev --local --ip 127.0.0.1 --port 8787 --var OPENAI_BASE_URL:http://127.0.0.1:8789",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      name: "web",
      command: "pnpm --filter @hell-ict/web dev --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
