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

test("個人情報を含む送信はブロックされ、入力欄は本文を保持したまま編集できる", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("チームコード").fill(uniqueTeamCode());
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.getByRole("heading", { name: "AIチャット" })).toBeVisible();

  const textarea = page.getByRole("textbox").last();
  await textarea.fill("渡辺 三郎さんの件で返信文を書いてください");
  await page.getByRole("button", { name: "送信" }).click();

  await expect(page.getByText("個人情報を検知したため、送信をブロックしました。")).toBeVisible();
  await expect(textarea).toBeEditable();
  await expect(textarea).toHaveValue("渡辺 三郎さんの件で返信文を書いてください");
});
