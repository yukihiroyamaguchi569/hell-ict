import { expect, test } from "@playwright/test";

import {
  enterTeam,
  openInboxByApi,
  retryButton,
  SAVED_TEAM_CODE_KEY,
  sessionTeamCode,
  uniqueTeamCode,
  welcomeHeading,
} from "./helpers";

/**
 * 保存済みコードからの自動復元が遅れている最中に、フォームから別のチームで入室した
 * ときの競合。遅い応答をあとから採ると、世代と状態が前のチームのもので上書きされ、
 * 「表示は新しいチーム・世代は前のチーム」という、以後の書き込みが全部409になる
 * 状態が残る。開始が新しいほうの応答だけを採ることを、画面に出る段階で確かめる。
 */
test("復元の応答が遅れている間に別チームで入室すると、あとから始めたほうが残る", async ({
  page,
}) => {
  const restored = uniqueTeamCode();
  const entered = uniqueTeamCode();

  // 復元されるチームだけ受信トレイまで進めておく。どちらが最終状態かを画面で見分けるため
  // ——両方ウェルカムのままだと、競合に負けても画面から区別が付かない。
  await page.goto("/");
  await enterTeam(page, restored, "復元班");
  await expect(welcomeHeading(page)).toBeVisible();
  await openInboxByApi(page.request, restored);

  // 復元されるチームの /api/session だけを遅らせる。あとから始まる入室のほうが先に返る。
  // 呼ばれた順ではなく本文のteamCodeで判定する——「1回目だけ遅らせる」だと、復元が
  // 2回呼ばれたときに2回目がそのまま通ってしまう。呼び出し回数に依存させない。
  await page.route("**/api/session", async (route) => {
    if (sessionTeamCode(route.request().postDataJSON()) === restored) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue();
  });

  await page.reload();
  // 復元が返る前に、フォームから別のチームで入る（復元中も入室欄は使える）。
  await expect(page.getByText("前回のチームへ戻っています…")).toBeVisible();
  await enterTeam(page, entered, "入室班");
  await expect(welcomeHeading(page)).toBeVisible();

  // 遅れていた復元の応答が届いても、画面は入室したチームのまま。
  await page.waitForTimeout(4000);
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByTestId("pane-left")).toBeHidden();
  await expect(page.getByTestId("team-chip")).toHaveText("入室班");

  // 入室したチームの世代でそのまま書き込みが通る（409 にならない）。古いタブ扱いにもならない。
  const opened = page.waitForResponse((response) => response.url().endsWith("/game/commands"));
  await page.getByRole("button", { name: "メールを開く" }).click();
  const response = await opened;
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ status: "applied" });
  await expect(page.getByTestId("inbox-list")).toBeVisible();
  await expect(page.getByText("この端末の状態は古くなっています。")).toHaveCount(0);
  // 次に開いたときに戻るのも、入室したチーム。
  const saved = await page.evaluate((key) => localStorage.getItem(key), SAVED_TEAM_CODE_KEY);
  expect(saved).toBe(entered);
});

/**
 * 追い越された復元が失敗（503）で終わったとき。追い越されたことのほうが先に決まるので、
 * 成功した入室の画面に「復元に失敗しました」を出してはいけない。
 */
test("追い越された復元が503で落ちても、成功した入室の表示を上書きしない", async ({ page }) => {
  const restored = uniqueTeamCode();
  const entered = uniqueTeamCode();

  await page.addInitScript(
    ({ key, code }) => {
      localStorage.setItem(key, code);
    },
    { key: SAVED_TEAM_CODE_KEY, code: restored },
  );

  // 復元のsessionだけを遅らせたうえで503にする。あとから始まる入室のほうが先に返る。
  await page.route("**/api/session", async (route) => {
    if (sessionTeamCode(route.request().postDataJSON()) !== restored) {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "チーム状態の処理に失敗しました。" }),
    });
  });

  await page.goto("/");
  await enterTeam(page, entered, "入室班");
  await expect(welcomeHeading(page)).toBeVisible();

  // 遅れていた復元が503で返っても、成功した側の画面に失敗の案内を出さない。
  await page.waitForTimeout(4000);
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByText("復元に失敗しました。")).toHaveCount(0);
  await expect(retryButton(page)).toHaveCount(0);
});
