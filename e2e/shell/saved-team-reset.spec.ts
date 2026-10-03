import { expect, test } from "@playwright/test";

import {
  enterButton,
  enterTeam,
  SAVED_TEAM_CODE_KEY,
  uniqueTeamCode,
  welcomeHeading,
} from "./helpers";

/**
 * 会場準備・ファシリテーター向けの `/?reset`。保存済みのチームを忘れて入室画面へ戻す。
 * 参加者の画面にはボタンを出さないので、URL だけが入口になる。
 */
test("/?reset で保存済みのチームを忘れ、再読み込みしても入室画面のまま", async ({ page }) => {
  const code = uniqueTeamCode();
  const savedCode = () => page.evaluate((key) => localStorage.getItem(key), SAVED_TEAM_CODE_KEY);

  await page.goto("/");
  await enterTeam(page, code, "A班");
  await expect(welcomeHeading(page)).toBeVisible();
  expect(await savedCode()).toBe(code);

  await page.goto("/?reset");
  await expect(enterButton(page)).toBeVisible();
  await expect(welcomeHeading(page)).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  expect(await savedCode()).toBeNull();

  // URL から reset が外れているので、再読み込みは「忘れ直し」ではなく通常の起動。
  await page.reload();
  await expect(enterButton(page)).toBeVisible();
  await expect(welcomeHeading(page)).toHaveCount(0);

  await page.goto("/");
  await expect(enterButton(page)).toBeVisible();
  await expect(welcomeHeading(page)).toHaveCount(0);

  // チーム名は残っているので、同じコードを打てば名前が戻る。
  await page.getByRole("textbox", { name: "チームコード 1桁目" }).click();
  await page.keyboard.type(code);
  await expect(page.getByRole("textbox", { name: "チーム名" })).toHaveValue("A班");
});

test("reset なしの / では従来どおり保存済みのチームへ自動で戻る", async ({ page }) => {
  const code = uniqueTeamCode();
  await page.goto("/");
  await enterTeam(page, code, "B班");
  await expect(welcomeHeading(page)).toBeVisible();

  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByTestId("team-chip")).toHaveText("B班");
  await expect(enterButton(page)).toHaveCount(0);
});

test("/?reset は他のクエリとハッシュを残す", async ({ page }) => {
  await page.goto("/?keep=1&reset=1#top");
  await expect(enterButton(page)).toBeVisible();
  const url = new URL(page.url());
  expect(url.search).toBe("?keep=1");
  expect(url.hash).toBe("#top");
});
