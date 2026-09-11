/**
 * ローカル開発とE2Eが使うポートの単一のソース。
 *
 * worktreeを2つ同時に走らせると、既定のポートを両方が掴んで衝突する。
 * 片方を `WORKER_PORT=8801 OPENAI_STUB_PORT=8802 WEB_PORT=4183 pnpm test:e2e`
 * のようにずらせるよう、ポート番号はここだけで決める。WEB_PORTも必ず一緒に
 * ずらす——Vite開発サーバーだけはreuseExistingServerで、別のworktreeが同じ
 * ポートで持っているものを掴んでしまう。specから直接 process.env を
 * 読むと、1箇所の読み漏れで「クリップボード権限が付かない」「スタブ照会が
 * 空を返す」といった無関係に見える失敗になる。
 */

const readPort = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  // 受け付けるのは10進数字だけ。Numberは`" 8801 "`も`"8e3"`も`"0x2261"`も通すが、
  // 同じ変数をシェル展開で読むapps/workerのdev scriptはそれらを解釈しない。ここだけが
  // 通ると、同じ設定でPlaywrightとWorkerが別のポートを見にいく。
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} にポート番号として使えない値が指定されている: ${raw}`);
  }
  return port;
};

/** wrangler dev（Worker/DO、配信版モックの配信元）。 */
export const WORKER_PORT = readPort("WORKER_PORT", 8787);

/** OpenAI Chat Completions APIのスタブ（e2e/openai-stub.mjs）。 */
export const OPENAI_STUB_PORT = readPort("OPENAI_STUB_PORT", 8789);

/** Vite開発サーバー（Reactハーネス）。 */
export const WEB_PORT = readPort("WEB_PORT", 4173);

export const WORKER_ORIGIN = `http://127.0.0.1:${String(WORKER_PORT)}`;
export const OPENAI_STUB_ORIGIN = `http://127.0.0.1:${String(OPENAI_STUB_PORT)}`;
export const WEB_ORIGIN = `http://127.0.0.1:${String(WEB_PORT)}`;
