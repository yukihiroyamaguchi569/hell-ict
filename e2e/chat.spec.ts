import { expect, test } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

test("チームに1つのAIチャットへ送信すると、スタブAIの応答が届く", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("チームコード").fill(uniqueTeamCode());
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.getByRole("heading", { name: "AIチャット" })).toBeVisible();

  await page.getByRole("textbox").last().fill("こんにちは");
  await page.getByRole("button", { name: "送信" }).click();

  await expect(page.getByText("（スタブ応答）承知しました。")).toBeVisible();
});
