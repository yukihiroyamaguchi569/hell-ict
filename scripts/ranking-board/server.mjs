import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 監査賞の同着処理は本番Workerと同じファイルを読む（Nodeが型を取り除いて読む。Issue #343）。
import { auditWinners } from "../../apps/worker/src/audit-winners.ts";

/**
 * デブリーフィング用の番付（着順と監査賞）を手元のブラウザへ映すローカルサーバー。
 * 本番Workerの画面（/ranking.html。apps/worker/src/debrief.ts）が使えないときの予備で、
 * Workerを経由しない。GET /api/results のたびに apps/worker/aggregation の
 * winner.sql と audit-award.sql を `wrangler d1 execute --remote --json` で流す
 * （SQLの意味は docs/development-harness.md）。
 * /handover は「次のICTへの申し送り」のページで、GET /api/handover のたびに handover.sql を流す。
 *
 *   node scripts/ranking-board/server.mjs <開催回2桁> [--local]
 *
 * SQL中の {{EVENT_NO}} を開催回へ置き換えて流す。既定値は持たない——置き換え先を
 * 取り違えると、別の回の番付を黙って映してしまう。--local は本番のD1ではなく、
 * `pnpm dev:worker`（wrangler dev --local）が使う手元のD1を読む（リハーサル・動作確認用）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "../../apps/worker");
const sqlDir = join(workerDir, "aggregation");
const PORT = 8790;
const WRANGLER_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const local = args.includes("--local");
const [eventNo] = args.filter((arg) => arg !== "--local");
if (eventNo === undefined || !/^\d{2}$/.test(eventNo) || args.length > (local ? 2 : 1)) {
  console.error("使い方: node scripts/ranking-board/server.mjs <開催回2桁> [--local]");
  process.exit(1);
}

const loadSql = async (name) =>
  (await readFile(join(sqlDir, name), "utf8")).replaceAll("{{EVENT_NO}}", eventNo);

/** wrangler --json の出力から結果の行だけを取り出す。形が違えば投げる。 */
const parseRows = (stdout) => {
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(rows)) throw new Error("wranglerの出力に results が無い");
  return rows;
};

const runSql = (sql) =>
  new Promise((resolve, reject) => {
    execFile(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "hell-ict-testplay",
        local ? "--local" : "--remote",
        "--json",
        "--command",
        sql,
      ],
      { cwd: workerDir, timeout: WRANGLER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`wranglerが失敗した: ${stderr || stdout || error.message}`));
          return;
        }
        try {
          resolve(parseRows(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });

// wranglerを同時に2つ起こすと、起動直後に片方が失敗することがあったので、
// 番付と申し送りをまたいで1本ずつ順に流す（前の失敗は次に持ち越さない）。
let sqlQueue = Promise.resolve();
const runSqlInTurn = (sql) => {
  const run = sqlQueue.then(() => runSql(sql));
  sqlQueue = run.catch(() => {});
  return run;
};

const fetchResults = async () => {
  const [winnerSql, auditSql] = await Promise.all([
    loadSql("winner.sql"),
    loadSql("audit-award.sql"),
  ]);
  const goals = await runSqlInTurn(winnerSql);
  const audit = await runSqlInTurn(auditSql);
  // チームコードは画面に出さない（見えた時点でそのチームへ入室できてしまう）。
  return {
    eventNo,
    fetchedAt: new Date().toISOString(),
    goals: goals.map((row) => ({ teamName: row.team_name ?? "", goalAtUtc: row.goal_at_utc })),
    audit: auditWinners(audit).map((row) => ({ teamName: row.team_name ?? "", s3Min: row.s3_min })),
  };
};

// 申し送りは text が空なら PIIゲートで本文ごと保存されなかった一言（pii_redacted = 1）。
const fetchHandover = async () => {
  const rows = await runSqlInTurn(await loadSql("handover.sql"));
  // チームコードは画面に出さない（番付と同じ理由）。
  return {
    eventNo,
    fetchedAt: new Date().toISOString(),
    handovers: rows.map((row) => ({ teamName: row.team_name ?? "", text: row.text ?? "" })),
  };
};

// 画面を複数開いても、同じ集計のwranglerは同時に1組だけにする。
const singleFlight = (fetcher) => {
  let inFlight = null;
  return () => {
    inFlight ??= fetcher().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
};
const fetchResultsOnce = singleFlight(fetchResults);
const fetchHandoverOnce = singleFlight(fetchHandover);

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

const sendApi = async (res, fetcher) => {
  try {
    sendJson(res, 200, await fetcher());
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
};

const sendPage = async (res, name) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(await readFile(join(here, name)));
};

const server = createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (req.url === "/api/results") {
    await sendApi(res, fetchResultsOnce);
    return;
  }
  if (req.url === "/api/handover") {
    await sendApi(res, fetchHandoverOnce);
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    await sendPage(res, "index.html");
    return;
  }
  if (req.url === "/handover") {
    await sendPage(res, "handover.html");
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `番付: http://127.0.0.1:${String(PORT)}/ （開催回 ${eventNo}、${local ? "手元のD1" : "本番のD1"}）`,
  );
  console.log(`申し送り: http://127.0.0.1:${String(PORT)}/handover`);
});
