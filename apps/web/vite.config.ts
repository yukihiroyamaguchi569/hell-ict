import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ポートの正はe2e/ports.ts。vite.config.tsはTSのimportを増やしたくないので、
// 同じ環境変数と既定値をここで読み直す。
const workerPort = process.env.WORKER_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${workerPort}`, ws: true },
    },
  },
});
