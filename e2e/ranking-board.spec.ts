import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * デブリーフィングの番付と申し送り（apps/worker/dashboard/ranking.html → /ranking.html）。
 *
 * 進捗ボードのGMモード（dashboard-gm.spec.ts）と同じく、実サーバを立てずに page.route で
 * HTMLとAPIを差し替える。集計そのものはWorkerのテスト（apps/worker/test/aggregation.test.ts）
 * で確かめてあり、ここで見たいのは鍵の受け渡しと「開いたときに1回だけ取る」ことである。
 */
const rankingHtml = readFileSync(
  new URL("../apps/worker/dashboard/ranking.html", import.meta.url),
  "utf8",
);

const BASE = "http://ranking.test";
const TOKEN_KEY = "hellIctAdminToken";

const results = {
  eventNo: "71",
  fetchedAt: "2026-10-31T03:00:00.000Z",
  goals: [
    { teamName: "一班", goalAtUtc: "2026-10-31 02:10:00.000" },
    { teamName: "三班", goalAtUtc: "2026-10-31 02:15:30.000" },
  ],
  audit: [{ teamName: "五班", s3Min: 0.4 }],
};

const handover = {
  eventNo: "71",
  fetchedAt: "2026-10-31T03:00:00.000Z",
  handovers: [
    { teamName: "一班", text: "マニュアルは原本を開け" },
    { teamName: "五班", text: "" },
  ],
};

/** APIの応答を差し替え、呼ばれたパスとAuthorizationを記録する。 */
type ApiStub = { status: number; calls: string[] };

const openRanking = async (page: Page, hash: string, api: ApiStub): Promise<void> => {
  await page.route(`${BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/ranking.html") {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: rankingHtml });
      return;
    }
    if (url.pathname.startsWith("/api/gm/debrief/")) {
      api.calls.push(`${url.pathname} ${route.request().headers()["authorization"] ?? ""}`);
      const body = url.pathname.endsWith("/results") ? results : handover;
      await route.fulfill(
        api.status === 200
          ? { contentType: "application/json", body: JSON.stringify(body) }
          : { status: api.status, body: "Not found" },
      );
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto(`${BASE}/ranking.html${hash}`);
};

const saveToken = async (page: Page, token: string): Promise<void> => {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: TOKEN_KEY, value: token },
  );
};

test("保存済みのトークンで開くと、番付と申し送りを1回ずつ取り、切り替えでは取り直さない", async ({
  page,
}) => {
  const api: ApiStub = { status: 200, calls: [] };
  await saveToken(page, "secret-token");
  await openRanking(page, "", api);

  const ranking = page.locator("#ranking");
  await expect(ranking.getByText("一班")).toBeVisible();
  await expect(ranking.getByText("五班")).toBeVisible();
  await expect(page.getByText("Stage 3 を 0.4 分で通過")).toBeVisible();
  await expect(page.getByLabel("GMトークン")).toBeHidden();

  await page.getByRole("link", { name: "申し送りへ" }).click();
  await expect(page.getByRole("heading", { name: "次のICTへの申し送り" })).toBeVisible();
  await expect(page.getByText("マニュアルは原本を開け")).toBeVisible();
  await expect(page.getByText("（記録なし）")).toBeVisible();

  await page.getByRole("link", { name: "番付へ" }).click();
  await expect(page.getByRole("heading", { name: "結果発表" })).toBeVisible();

  expect(api.calls.sort()).toEqual([
    "/api/gm/debrief/handover Bearer secret-token",
    "/api/gm/debrief/results Bearer secret-token",
  ]);
});

test("トークンが無ければ欄を出してAPIを呼ばず、保存したら取りに行く", async ({ page }) => {
  const api: ApiStub = { status: 200, calls: [] };
  await openRanking(page, "#handover", api);
  await expect(page.getByLabel("GMトークン")).toBeVisible();
  expect(api.calls).toEqual([]);

  await page.getByLabel("GMトークン").fill("typed-token");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("マニュアルは原本を開け")).toBeVisible();
  await expect(page.getByLabel("GMトークン")).toBeHidden();
  expect(api.calls).toContain("/api/gm/debrief/handover Bearer typed-token");
});

test("404はトークンの確認を促し、結果は出さない", async ({ page }) => {
  const api: ApiStub = { status: 404, calls: [] };
  await saveToken(page, "wrong-token");
  await openRanking(page, "", api);
  await expect(page.getByText("トークンを確認してください", { exact: true })).toBeVisible();
  await expect(page.getByLabel("GMトークン")).toBeVisible();
  await expect(page.getByText("一班")).toHaveCount(0);
});
