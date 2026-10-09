import type { JobResult, ModelSummary } from "./bench.ts";
import type { BenchCase } from "./cases.ts";
import { PRODUCTION_TIMEOUT_MS } from "./config.ts";
import { RATE_LIMIT_HEADERS } from "./openai.ts";

/**
 * The HTML report: one self-contained file (no CDN, no script) that puts each case's replies
 * side by side, so the Japanese of the models can be compared by eye.
 */

export type BenchRun = {
  readonly startedAt: string;
  readonly models: readonly string[];
  readonly repeat: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly cases: readonly BenchCase[];
  readonly results: readonly JobResult[];
  readonly summaries: readonly ModelSummary[];
};

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatMs = (ms: number | null): string =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)} 秒`;

export const formatUsd = (usd: number | null): string =>
  usd === null ? "不明" : `$${usd.toFixed(usd < 0.01 ? 5 : 3)}`;

const ROLE_LABELS = { system: "system", user: "参加者", assistant: "AI（9/26）" } as const;

const renderMessages = (benchCase: BenchCase): string =>
  benchCase.messages
    .map(
      (message) =>
        `<div class="msg ${message.role}"><div class="role">${ROLE_LABELS[message.role]}</div><pre>${escapeHtml(message.content)}</pre></div>`,
    )
    .join("");

const renderCallMeta = (result: JobResult): string => {
  const usage =
    result.usage === null
      ? "トークン 不明"
      : `入力 ${String(result.usage.promptTokens)} / 出力 ${String(result.usage.completionTokens)}` +
        (result.usage.reasoningTokens > 0 ? ` / 推論 ${String(result.usage.reasoningTokens)}` : "");
  const badge = result.overProductionTimeout
    ? `<span class="badge late">本番ならタイムアウト（${String(PRODUCTION_TIMEOUT_MS / 1000)} 秒超）</span>`
    : result.cutOffBeforeProductionTimeout
      ? `<span class="badge late">打ち切り（本番での判定不能）</span>`
      : "";
  return `<div class="meta">${formatMs(result.elapsedMs)} · ${usage} · ${formatUsd(result.costUsd)} · HTTP ${result.status === null ? "—" : String(result.status)}${badge}</div>`;
};

const renderCall = (result: JobResult): string => {
  const round = `<div class="round">${String(result.round)} 回目</div>`;
  const body =
    result.error === null
      ? `<pre class="reply">${escapeHtml(result.text ?? "")}</pre>`
      : `<div class="error">エラー（${escapeHtml(result.error.kind)}）: ${escapeHtml(result.error.message)}</div>`;
  return `<div class="call">${round}${renderCallMeta(result)}${body}</div>`;
};

const renderCase = (benchCase: BenchCase, run: BenchRun): string => {
  const columns = run.models
    .map((model) => {
      const calls = run.results
        .filter((result) => result.caseId === benchCase.id && result.model === model)
        .sort((a, b) => a.round - b.round)
        .map(renderCall)
        .join("");
      return `<div class="col"><h3>${escapeHtml(model)}</h3>${calls}</div>`;
    })
    .join("");
  const last = benchCase.messages.at(-1)?.content ?? "";
  return `<section class="case" id="${escapeHtml(benchCase.id)}">
<h2>${escapeHtml(benchCase.id)} <span class="stage">${escapeHtml(benchCase.stage)}</span> ${escapeHtml(benchCase.label)}</h2>
<div class="ask"><div class="role">今回の入力</div><pre>${escapeHtml(last)}</pre></div>
<details><summary>送った会話の全体（${String(benchCase.messages.length)} 件）</summary>${renderMessages(benchCase)}</details>
<div class="cols" style="--cols:${String(run.models.length)}">${columns}</div>
</section>`;
};

const renderSummary = (summaries: readonly ModelSummary[]): string => {
  const rows = summaries
    .map(
      (summary) =>
        `<tr><th>${escapeHtml(summary.model)}</th><td>${String(summary.calls)}</td><td>${formatMs(summary.medianMs)}</td><td>${formatMs(summary.maxMs)}</td><td>${String(summary.promptTokens)}</td><td>${String(summary.completionTokens)}</td><td>${String(summary.reasoningTokens)}</td><td>${String(summary.usageUnknown)}</td><td>${formatUsd(summary.totalCostUsd)}</td><td>${String(summary.overProductionTimeout)}</td><td>${String(summary.cutOffBeforeProductionTimeout)}</td><td>${String(summary.errors)}</td></tr>`,
    )
    .join("");
  return `<h2>モデルごとの集計</h2>
<p class="note">所要時間の中央値・最大は、成功した呼び出しだけで数える。トークン数は usage が読めた応答だけの合計で、1件でも費用が分からない応答があれば合計費用は「不明」にする。「${String(PRODUCTION_TIMEOUT_MS / 1000)} 秒超」は Worker の待ち時間を超えたもの（本番なら参加者には失敗に見える）。「打ち切り（判定不能）」は ${String(PRODUCTION_TIMEOUT_MS / 1000)} 秒より短い --timeout-ms で打ち切ったもの。</p>
<table><thead><tr><th>モデル</th><th>呼び出し</th><th>中央値</th><th>最大</th><th>入力トークン</th><th>出力トークン</th><th>推論トークン</th><th>usage 不明</th><th>費用（推定）</th><th>${String(PRODUCTION_TIMEOUT_MS / 1000)} 秒超</th><th>打ち切り（判定不能）</th><th>エラー</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const renderRateLimits = (summaries: readonly ModelSummary[]): string => {
  const head = RATE_LIMIT_HEADERS.map(
    (name) => `<th>${name.replace("x-ratelimit-", "")}</th>`,
  ).join("");
  const rows = summaries
    .map((summary) => {
      const cells = RATE_LIMIT_HEADERS.map(
        (name) => `<td>${escapeHtml(summary.rateLimit[name] ?? "—")}</td>`,
      ).join("");
      return `<tr><th>${escapeHtml(summary.model)}</th>${cells}</tr>`;
    })
    .join("");
  return `<h2>rate limit（モデルごとに最後に受け取った値）</h2>
<table><thead><tr><th>モデル</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
};

const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#d9d9de;--card:#f6f6f8;--late:#b42318;--late-bg:#fde8e7}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--muted:#a0a0a8;--line:#3a3a40;--card:#212125;--late:#ff8a80;--late-bg:#3d1f1d}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif}
h1{font-size:20px}h2{font-size:17px;margin-top:32px}h3{font-size:14px;margin:0 0 6px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}
.note,.meta,.round,.role{color:var(--muted);font-size:12px}
.case{border-top:1px solid var(--line);padding-top:8px}
.stage{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:0 6px}
.ask,.msg{background:var(--card);border-radius:6px;padding:8px;margin:6px 0;max-height:16em;overflow:auto}
.cols{display:grid;grid-template-columns:repeat(var(--cols),minmax(260px,1fr));gap:12px;overflow-x:auto}
.col{min-width:0}.call{border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px}
.badge.late{display:inline-block;margin-left:6px;color:var(--late);background:var(--late-bg);border-radius:4px;padding:0 6px}
.error{color:var(--late)}
table{border-collapse:collapse;margin:8px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:right;white-space:nowrap}
thead th,tbody th{text-align:left}
`;

export const renderReport = (run: BenchRun): string => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIモデル比較</title><style>${STYLE}</style></head><body>
<h1>AIモデル比較（地獄のICT）</h1>
<p class="note">${escapeHtml(run.startedAt)} 開始 · モデル ${escapeHtml(run.models.join(", "))} · ケース ${String(run.cases.length)} 件 × ${String(run.repeat)} 回 · 並列 ${String(run.concurrency)} · 打ち切り ${String(run.timeoutMs / 1000)} 秒</p>
${run.cases.map((benchCase) => renderCase(benchCase, run)).join("\n")}
${renderSummary(run.summaries)}
${renderRateLimits(run.summaries)}
</body></html>
`;
