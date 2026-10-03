import { expect, test } from "@playwright/test";

import {
  enterButton,
  enterTeam,
  openInboxByApi,
  retryButton,
  uniqueTeamCode,
  welcomeHeading,
} from "./helpers";

/**
 * 保存済みコードからの復元が失敗したときの画面。旧ハーネスでは、復元の `/api/session` が
 * 503 でも別経路の状態だけで操作できる画面が出て、リセット世代を持たないまま書き込みが
 * 黙って落ちた。復元が成立するまで操作画面を出さず、失敗は［再試行］で拾えることを見る。
 */
test("復元に失敗したら操作画面を出さず、再試行を出す", async ({ page }) => {
  const code = uniqueTeamCode();

  // いちど入室して受信トレイまで進め、保存済みコードから復元される状態を作る。
  await page.goto("/");
  await enterTeam(page, code, "A班");
  await expect(welcomeHeading(page)).toBeVisible();
  await openInboxByApi(page.request, code);
  await page.reload();
  await expect(page.getByTestId("pane-left")).toBeVisible();

  // 復元の /api/session だけを落とす（疎通確認の /api/health は通る）。
  let failing = true;
  await page.route("**/api/session", async (route) => {
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "チーム状態の処理に失敗しました。" }),
      });
      return;
    }
    await route.continue();
  });

  await page.reload();
  await expect(page.getByText("復元に失敗しました。")).toBeVisible();
  // 操作画面（ウェルカム・受信トレイのペイン）は出ない。別のチームでの入室もさせない。
  await expect(page.getByTestId("pane-left")).toBeHidden();
  await expect(welcomeHeading(page)).toHaveCount(0);
  await expect(enterButton(page)).toBeDisabled();

  // 復旧したら［再試行］で同じチームへ戻れる。
  failing = false;
  await retryButton(page).click();
  await expect(page.getByTestId("pane-left")).toBeVisible();
  await expect(page.getByTestId("team-chip")).toHaveText("A班");
  await expect(retryButton(page)).toHaveCount(0);
});
