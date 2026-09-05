import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * 会場ディスプレイ用ダッシュボード（apps/worker/dashboard/index.html）のGMモード。
 *
 * 実サーバを立てず、page.routeでHTMLとAPIを差し替えて動かす。ダッシュボードは
 * `pnpm build:testplay`でpublic/へコピーされる生成物なので、E2Eの起動サーバから
 * 配信されるとは限らない——ここで見たいのは画面の分岐であって配信経路ではない。
 */
const dashboardHtml = readFileSync(
  new URL("../apps/worker/dashboard/index.html", import.meta.url),
  "utf8",
);

const BASE = "http://dashboard.test";
const PUBLIC_ID = "0a1b2c3d";

const summary = {
  teams: [
    {
      publicId: PUBLIC_ID,
      teamName: "感染対策室",
      pos: 3,
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    },
  ],
  events: [],
};

/** リセットAPIの応答を差し替えられるようにしつつ、呼ばれた回数も数える。 */
type ResetStub = { status: number; calls: string[] };

const openDashboard = async (page: Page, hash: string, reset: ResetStub): Promise<void> => {
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
    if (url.pathname.startsWith("/api/gm/")) {
      reset.calls.push(route.request().headers()["authorization"] ?? "");
      await route.fulfill({
        status: reset.status,
        contentType: "application/json",
        body: reset.status === 200 ? '{"ok":true}' : '"Not found"',
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto(`${BASE}/dashboard.html${hash}`);
  await expect(page.getByText("感染対策室")).toBeVisible();
};

test("ハッシュなしではトークン欄もリセットボタンも出ない", async ({ page }) => {
  await openDashboard(page, "", { status: 200, calls: [] });
  await expect(page.getByLabel("GMトークン")).toBeHidden();
  await expect(page.getByRole("button", { name: "リセット" })).toHaveCount(0);
});

test("#gmでトークン欄とリセットボタンが出て、確認を取り消すと何も呼ばない", async ({ page }) => {
  const reset: ResetStub = { status: 200, calls: [] };
  await openDashboard(page, "#gm", reset);
  await expect(page.getByLabel("GMトークン")).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("感染対策室");
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "リセット" }).click();
  await expect(page.getByText("リセットしました")).toHaveCount(0);
  expect(reset.calls).toEqual([]);
});

test("保存したトークンをBearerで送り、結果を行に表示する", async ({ page }) => {
  const reset: ResetStub = { status: 200, calls: [] };
  await openDashboard(page, "#gm", reset);
  await page.getByLabel("GMトークン").fill("secret-token");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("button", { name: "リセット" }).click();
  await expect(page.getByText("リセットしました")).toBeVisible();
  expect(reset.calls).toEqual(["Bearer secret-token"]);
});

test("404はトークンの確認を促す", async ({ page }) => {
  const reset: ResetStub = { status: 404, calls: [] };
  await openDashboard(page, "#gm", reset);
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("button", { name: "リセット" }).click();
  await expect(page.getByText("トークンを確認してください")).toBeVisible();
});
