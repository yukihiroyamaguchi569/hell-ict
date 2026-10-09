import { PRODUCTION_TIMEOUT_MS } from "./config.ts";
import type { LoadOutcome } from "./load.ts";
import type { LoadSummary, SecondRow } from "./load-stats.ts";
import { escapeHtml, formatUsd } from "./report.ts";

/** The load-test report: one self-contained HTML file of tables (no charts, no CDN, no script). */

export type LoadRun = {
  readonly startedAt: string;
  readonly model: string;
  readonly concurrency: number;
  readonly durationMs: number | null;
  readonly timeoutMs: number;
  readonly casesCount: number;
  readonly outcome: LoadOutcome;
  readonly summary: LoadSummary;
  readonly seconds: readonly SecondRow[];
};

const STOP_LABELS = {
  duration: "継続時間に達した",
  "burst-done": "バーストの全件が終わった",
  "max-requests": "件数の上限に達した",
  "max-cost": "費用の上限に達しそうになった",
  "429-in-a-row": "429 が続いた",
  "429-ratio": "429 の割合が上限を超えた",
} as const;

const ms = (value: number | null): string =>
  value === null ? "—" : `${(value / 1000).toFixed(1)} 秒`;
const int = (value: number | null): string =>
  value === null ? "—" : Math.round(value).toLocaleString("en-US");

const totalCost = (summary: LoadSummary): string =>
  summary.totalCostUsd === null
    ? `不明（下限 ${formatUsd(summary.costLowerBoundUsd)}）`
    : formatUsd(summary.totalCostUsd);

const row = (cells: readonly string[]): string =>
  `<tr>${cells.map((cell, index) => (index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`)).join("")}</tr>`;

const renderSummary = (summary: LoadSummary): string => {
  const late = String(PRODUCTION_TIMEOUT_MS / 1000);
  const rows: [string, string][] = [
    ["完了", int(summary.completed)],
    ["成功", int(summary.succeeded)],
    ["429", int(summary.rateLimited)],
    [`${late} 秒超（本番ならタイムアウト）`, int(summary.overProductionTimeout)],
    ["打ち切り（本番での判定不能）", int(summary.cutOffBeforeProductionTimeout)],
    ["通信エラー", int(summary.network)],
    [
      "所要時間 p50 / p95 / p99 / 最大（成功のみ）",
      [summary.p50Ms, summary.p95Ms, summary.p99Ms, summary.maxMs].map(ms).join(" / "),
    ],
    ["RPM（実測、1 分あたり）", int(summary.rpm)],
    ["TPM（実測、usage から）", int(summary.tpm)],
    ["remaining-requests の最小", int(summary.minRemainingRequests)],
    ["remaining-tokens の最小", int(summary.minRemainingTokens)],
    ["費用", totalCost(summary)],
  ];
  return `<table><tbody>${rows.map(([label, value]) => row([escapeHtml(label), value])).join("")}</tbody></table>`;
};

const renderOutcomes = (summary: LoadSummary): string => {
  const rows = Object.entries(summary.outcomes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => row([escapeHtml(key), int(count)]))
    .join("");
  return `<h2>結果の内訳（HTTP ステータスと error code）</h2>
<table><thead><tr><th>結果</th><th>件数</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const renderSeconds = (seconds: readonly SecondRow[]): string => {
  const head = [
    "秒",
    "開始",
    "完了",
    "成功",
    "429",
    "20 秒超",
    "通信エラー",
    "p50",
    "最大",
    "RPM 換算",
    "TPM 換算",
    "残り requests 最小",
    "残り tokens 最小",
  ];
  const rows = seconds
    .map((second) =>
      row([
        String(second.second),
        int(second.started),
        int(second.completed),
        int(second.succeeded),
        int(second.rateLimited),
        int(second.overProductionTimeout),
        int(second.network),
        ms(second.p50Ms),
        ms(second.maxMs),
        int(second.rpm),
        int(second.tpm),
        int(second.minRemainingRequests),
        int(second.minRemainingTokens),
      ]),
    )
    .join("");
  return `<h2>1 秒ごと（終わった時刻で数える）</h2>
<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
};

const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#d9d9de}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--muted:#a0a0a8;--line:#3a3a40}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif}
h1{font-size:20px}h2{font-size:17px;margin-top:28px}.note{color:var(--muted);font-size:12px}
table{border-collapse:collapse;margin:8px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:right;white-space:nowrap}
tbody th,thead th{text-align:left}
`;

export const renderLoadReport = (run: LoadRun): string => {
  const mode =
    run.durationMs === null
      ? `バースト（${String(run.concurrency)} 件を同時に1回）`
      : `同時 ${String(run.concurrency)} 件を ${String(run.durationMs / 1000)} 秒`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI負荷テスト</title><style>${STYLE}</style></head><body>
<h1>AI負荷テスト（地獄のICT）</h1>
<p class="note">${escapeHtml(run.startedAt)} 開始 · ${escapeHtml(run.model)} · ${mode} · ケース ${String(run.casesCount)} 件を順に · 打ち切り ${String(run.timeoutMs / 1000)} 秒 · 実時間 ${ms(run.outcome.wallMs)}</p>
<p>止まった理由: <strong>${STOP_LABELS[run.outcome.stopReason]}</strong></p>
<h2>全体</h2>
${renderSummary(run.summary)}
${renderOutcomes(run.summary)}
${renderSeconds(run.seconds)}
</body></html>
`;
};
