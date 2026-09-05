import { expect, test } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

const savedTeamCodeKey = "hell-ict-team-code";

/**
 * 保存済みコードからの復元が失敗したときの画面。以前はWebSocketを`/api/session`と
 * 並行して開いていたため、sessionが503でもsocketのsnapshotだけで操作できる画面が出て、
 * リセット世代を持たないまま書き込みが黙って落ちた。復元が成立するまで操作画面を
 * 出さず、失敗は［再試行］で拾えることを見る。
 */
test("復元に失敗したら操作画面を出さず、再試行を出す", async ({ page }) => {
  const code = uniqueTeamCode();

  // いちど入室して Stage 1 まで進め、保存済みコードから復元される状態を作る。
  await page.goto("/");
  await page.getByLabel("チームコード").fill(code);
  await page.getByRole("button", { name: "入室する" }).click();
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: savedTeamCodeKey, value: code },
  );

  // 復元の /api/session だけを落とす。WebSocketは素通しにして、socketのsnapshotだけで
  // 操作画面が出てしまわないことを確かめる（これが直したかった経路そのもの）。
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
  // 操作画面（ステージの見出しと進行ボタン）は出ない。
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Prologue: 着任" })).toHaveCount(0);

  // 復旧したら［再試行］で入り直せる。
  failing = false;
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();
  await expect(page.getByRole("button", { name: "再試行" })).toHaveCount(0);
});
