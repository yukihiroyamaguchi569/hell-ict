import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ポートの正はe2e/ports.ts。アプリの設定をE2Eコードへ依存させたくないので、
// 同じ変数名・既定値・受け付ける書式（10進数字だけ）をここで読み直す。
const readWorkerPort = (): string => {
  const raw = process.env.WORKER_PORT;
  if (raw === undefined || raw === "") return "8787";
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WORKER_PORT にポート番号として使えない値が指定されている: ${raw}`);
  }
  return raw;
};

const workerPort = readWorkerPort();

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${workerPort}`, ws: true },
    },
  },
});
