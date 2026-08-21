import { expect, test } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

test("受信トレイの1通に返信すると返信済みになる", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("チームコード").fill(uniqueTeamCode());
  await page.getByRole("button", { name: "入室する" }).click();

  const briefing = page.getByRole("dialog", { name: "事務長ブリーフィング" });
  await briefing.click(); // 演出を飛ばして全ビートを表示する
  await page.getByRole("button", { name: "了解しました" }).click();

  const inbox = page.getByRole("navigation", { name: "受信トレイ" });
  const firstEmail = inbox.getByRole("button").first();
  await expect(firstEmail).toBeVisible();
  await firstEmail.click();

  await page.getByLabel("返信").fill("承知しました。担当に確認のうえ、折り返しご連絡いたします。");
  await page.getByRole("button", { name: "送信する" }).click();

  await expect(firstEmail).toContainText("返信済み");
});
