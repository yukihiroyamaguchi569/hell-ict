import { expect, test, type Page, type Route } from "@playwright/test";

import { enterButton, enterTeam, uniqueTeamCode, welcomeHeading } from "./helpers";

/**
 * 入室前の読み込み画面（Issue #379）。ページを開くと病院の外観に「読み込み中 N%」と割合の
 * バーを重ね、画像と効果音をまとめて先読みする。全部終わるか15秒で、クリックを待たずに入室
 * 画面へ進む。保存済みのチームで再読み込みしたときは出さずに裏で読む。
 *
 * 先読みは production の画像27枚と効果音7種の34件。wrangler dev --local の R2 は空なので、
 * 効果音はすぐ 404 で終わる（失敗も1件として数える）。下では画像を1枚だけ止めて、残り1件の
 * 状態（33/34 ＝ 97%）を作る。
 * 止めた画像はページの load を止めるので、goto と reload は domcontentloaded までしか待たない。
 */

const HELD_IMAGE = "**/assets/images/production/stage5-poster-default.png";

const opening = (page: Page) => page.getByTestId("opening");
const progress = (page: Page) => page.getByRole("progressbar", { name: "読み込み中" });

/** 画像1枚の応答を止めておき、`release` で流す。 */
const holdImage = async (page: Page) => {
  const held: Route[] = [];
  await page.route(HELD_IMAGE, (route) => {
    held.push(route);
  });
  return {
    release: async (): Promise<void> => {
      await Promise.all(held.map((route) => route.continue()));
      await page.unroute(HELD_IMAGE);
    },
  };
};

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("読み込み中は病院の外観と割合を出し、読み終わったらクリックなしで入室画面へ進む", async ({
  page,
}) => {
  const image = await holdImage(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(opening(page)).toBeVisible();
  await expect(opening(page).getByRole("status")).toHaveText("読み込み中 97%");
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "97");
  const art = opening(page).getByRole("img", { name: "聖クロノス総合病院の外観" });
  await expect
    .poll(() => art.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  // 読み込み中は入室画面を出さない。
  await expect(enterButton(page)).toHaveCount(0);

  await image.release();
  await expect(opening(page)).toHaveCount(0);
  await expect(enterButton(page)).toBeVisible();
});

test("読み込みに失敗したものがあっても、止まらずに入室画面へ進む", async ({ page }) => {
  await page.route(HELD_IMAGE, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/");
  await expect(enterButton(page)).toBeVisible();
  await expect(opening(page)).toHaveCount(0);
});

test("読み終わらなくても15秒で入室画面へ進む（残りは裏で読み続ける）", async ({ page }) => {
  await page.clock.install();
  const image = await holdImage(page);
  const health = page.waitForResponse("**/api/health");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await health;
  await expect(opening(page).getByRole("status")).toHaveText("読み込み中 97%");

  await page.clock.fastForward(14_000);
  await expect(opening(page)).toBeVisible();
  await page.clock.fastForward(1_000);
  await expect(opening(page)).toHaveCount(0);
  await expect(enterButton(page)).toBeVisible();

  // 止めていた1枚は、入室画面の後ろでそのまま読み終わる。
  const loaded = page.waitForResponse(
    (response) => response.url().endsWith("/stage5-poster-default.png") && response.ok(),
  );
  await image.release();
  await loaded;
});

test("保存済みのチームで再読み込みしたら読み込み画面を出さず、ゲームへ戻る", async ({ page }) => {
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");
  await expect(welcomeHeading(page)).toBeVisible();

  const image = await holdImage(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(opening(page)).toHaveCount(0);
  await image.release();
});
