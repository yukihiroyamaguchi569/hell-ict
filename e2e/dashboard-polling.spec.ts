import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * 定期取得するページは、タブが見えている間だけポーリングする（hell-ict#22）。開きっぱなしの
 * 進捗ボードが裏のタブでも10秒ごとにD1を読み続け、無料プランのrows readを使い切った。
 *
 * 対象は進捗ボード（/dashboard.html）と、手元の予備の番付サーバ（scripts/ranking-board/）の
 * 番付・申し送り。/ranking.html は開いたときに1回取るだけなので対象外（ranking-board.spec.ts）。
 *
 * 実サーバを立てず、page.routeでHTMLとAPIを差し替え、page.clockで時間を進める。
 * `document.visibilityState`はページから書き換えられないので、初期化スクリプトで
 * window.__visibility を返すgetterへ差し替え、切り替えのたびにvisibilitychangeを撃つ。
 */
type Board = { name: string; html: string; page: string; api: string; pollMs: number };

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const BOARDS: Board[] = [
  {
    name: "進捗ボード",
    html: read("../apps/worker/dashboard/index.html"),
    page: "/dashboard.html",
    api: "/api/progress/summary",
    pollMs: 10_000,
  },
  {
    name: "予備の番付",
    html: read("../scripts/ranking-board/index.html"),
    page: "/",
    api: "/api/results",
    pollMs: 30_000,
  },
  {
    name: "予備の申し送り",
    html: read("../scripts/ranking-board/handover.html"),
    page: "/handover",
    api: "/api/handover",
    pollMs: 30_000,
  },
];

const BASE = "http://board.test";

/** 各APIが返す空の結果。形の検証を通る最小のもの。 */
const EMPTY_BODY: Record<string, unknown> = {
  "/api/progress/summary": { teams: [], events: [] },
  "/api/results": { eventNo: "99", fetchedAt: "2026-10-31T03:00:00.000Z", goals: [], audit: [] },
  "/api/handover": { eventNo: "99", fetchedAt: "2026-10-31T03:00:00.000Z", handovers: [] },
};

const FAKE_VISIBILITY = `
  window.__visibility = window.__initialVisibility || "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => window.__visibility,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => window.__visibility !== "visible",
  });
`;

const setVisibility = async (page: Page, state: "visible" | "hidden"): Promise<void> => {
  await page.evaluate((next) => {
    Object.assign(window, { __visibility: next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
};

/** ページを開き、APIが呼ばれた回数を数える。 */
const openBoard = async (
  page: Page,
  board: Board,
  initial: "visible" | "hidden" = "visible",
): Promise<{ calls: () => number }> => {
  let calls = 0;
  await page.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === board.page) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: board.html });
      return;
    }
    if (url.pathname === board.api) {
      calls += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(EMPTY_BODY[board.api]),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });
  await page.addInitScript(
    `window.__initialVisibility = ${JSON.stringify(initial)};\n${FAKE_VISIBILITY}`,
  );
  await page.goto(`${BASE}${board.page}`);
  return { calls: () => calls };
};

/** 偽の時計を進める。進捗ボードの1秒タイマーがあるので5秒ずつに分ける（dashboard-timer.spec.ts）。 */
const runFor = async (page: Page, ms: number): Promise<void> => {
  for (let done = 0; done < ms; done += 5000) {
    await page.clock.runFor(Math.min(5000, ms - done));
  }
};

const START = new Date("2026-10-31T10:00:00+09:00").getTime();

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
});

for (const board of BOARDS) {
  test.describe(board.name, () => {
    test("見えている間は間隔ごとに取り、隠れたら止まり、見えたらすぐ1回取って間隔へ戻る", async ({
      page,
    }) => {
      const api = await openBoard(page, board);
      await expect.poll(api.calls).toBe(1);
      await runFor(page, board.pollMs);
      await expect.poll(api.calls).toBe(2);

      await setVisibility(page, "hidden");
      await runFor(page, board.pollMs * 5);
      expect(api.calls()).toBe(2);

      await setVisibility(page, "visible");
      await expect.poll(api.calls).toBe(3);
      // 再開後のタイマーが1本だけであること（二重なら1間隔で2回増える）。
      await runFor(page, board.pollMs);
      await expect.poll(api.calls).toBe(4);
      await runFor(page, board.pollMs - 1000);
      expect(api.calls()).toBe(4);
    });

    test("隠れたまま開いたら取らず、見えたときに初めて取る", async ({ page }) => {
      const api = await openBoard(page, board, "hidden");
      await runFor(page, board.pollMs * 3);
      expect(api.calls()).toBe(0);

      await setVisibility(page, "visible");
      await expect.poll(api.calls).toBe(1);
      await runFor(page, board.pollMs);
      await expect.poll(api.calls).toBe(2);
    });

    test("見えたままvisibilitychangeが続けて来ても、取り直しもタイマーも増えない", async ({
      page,
    }) => {
      const api = await openBoard(page, board);
      await expect.poll(api.calls).toBe(1);

      await setVisibility(page, "visible");
      await setVisibility(page, "visible");
      await runFor(page, board.pollMs);
      await expect.poll(api.calls).toBe(2);
      await runFor(page, board.pollMs - 1000);
      expect(api.calls()).toBe(2);
    });
  });
}
