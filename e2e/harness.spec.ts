import { expect, test } from "@playwright/test";

test("開発ハーネスの画面を表示する", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "地獄のICT" })).toBeVisible();
  await expect(page.getByText("実行可能な開発ハーネスは稼働中です。")).toBeVisible();
});
