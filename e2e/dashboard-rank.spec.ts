import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * 会場ディスプレイ用ダッシュボードの順位表示（Issue #159）。並び替えはサーバの仕事なので
 * （test/progress.test.ts）、ここではサマリーの並びどおりに上から1位、2位…と振ることを見る。
 * dashboard-gm.spec.tsと同じく、実サーバを立てずpage.routeでHTMLとAPIを差し替える。
 */
const dashboardHtml = readFileSync(
  new URL("../apps/worker/dashboard/index.html", import.meta.url),
  "utf8",
);

const BASE = "http://dashboard.test";
const now = new Date().toISOString().replace("T", " ").slice(0, 19);

const summary = {
  teams: [
    { publicId: "0a1b2c3d", teamName: "ゴール班", pos: 7, updatedAt: now },
    { publicId: "1a1b2c3d", teamName: "先着班", pos: 4, updatedAt: now },
    { publicId: "2a1b2c3d", teamName: "後着班", pos: 4, updatedAt: now },
    { publicId: "3a1b2c3d", teamName: "出遅れ班", pos: 1, updatedAt: now },
  ],
  events: [],
};

test("サマリーの並びどおりに1位から順位を振り、ゴールしたチームは先頭に出る", async ({ page }) => {
  await page.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/dashboard.html") {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: dashboardHtml });
      return;
    }
    if (url.pathname === "/api/progress/summary") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(summary) });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto(`${BASE}/dashboard.html`);

  const rows = page.locator(".team");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator(".rank")).toHaveText(["1位", "2位", "3位", "4位"]);
  await expect(rows.locator(".name")).toContainText(["ゴール班", "先着班", "後着班", "出遅れ班"]);
  await expect(rows.first()).toHaveClass(/\bgoal\b/);
});
