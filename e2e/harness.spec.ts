import { expect, test } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

test("チームが入室してStage 1へ進み、再読込後も復元する", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("チームコード").fill(uniqueTeamCode());
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.getByRole("heading", { name: "Prologue: 着任" })).toBeVisible();
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();
});

test("不正なチームコードを拒否する", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("チームコード").fill("１２３４５６");
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.getByText("ASCII数字6桁で入力してください。")).toBeVisible();
});
