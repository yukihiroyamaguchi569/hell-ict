import { expect, test } from "@playwright/test";

import {
  enterButton,
  enterTeam,
  fillEntry,
  openInboxByApi,
  retryButton,
  uniqueTeamCode,
  welcomeHeading,
} from "./helpers";

test("入室するとウェルカムが出て、再読み込みしても同じ画面へ戻る", async ({ page }) => {
  const code = uniqueTeamCode();
  await page.goto("/");
  await enterTeam(page, code, "発熱対策室");

  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByTestId("team-chip")).toHaveText("発熱対策室");
  // ウェルカムにはペインが無い（受信トレイもAIも出さない）
  await expect(page.getByTestId("pane-left")).toBeHidden();
  await expect(page.getByTestId("pane-right")).toBeHidden();

  // 保存済みのチームコードから自動で戻る。入室欄を経由しない。
  await page.reload();
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByTestId("team-chip")).toHaveText("発熱対策室");
  await expect(enterButton(page)).toHaveCount(0);
});

test("受信トレイを開いた後に再読み込みしても、ウェルカムへは戻らない", async ({ page }) => {
  const code = uniqueTeamCode();
  await page.goto("/");
  await enterTeam(page, code, "A班");
  await expect(welcomeHeading(page)).toBeVisible();
  await openInboxByApi(page.request, code);

  await page.reload();
  await expect(page.getByTestId("pane-left")).toBeVisible();
  await expect(welcomeHeading(page)).toHaveCount(0);
  await expect(enterButton(page)).toHaveCount(0);
});

test("入室したらダッシュボード向けに POST /api/progress を送る", async ({ page }) => {
  const code = uniqueTeamCode();
  await page.goto("/");
  const reported = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/progress"),
  );
  await enterTeam(page, code, "発熱対策室");
  const body: unknown = (await reported).postDataJSON();
  expect(body).toMatchObject({
    teamCode: code,
    teamName: "発熱対策室",
    pos: 0,
    view: "welcome",
    kind: "entry",
  });
  expect(body).toHaveProperty("generation");
  expect(body).toHaveProperty("clientAt");
});

test("残した名前は同じコードで戻り、別のコードに直すと持ち越さない", async ({ page }) => {
  const code = "314159";
  await page.addInitScript((key) => {
    localStorage.setItem(key, "前回の班");
  }, `hellTeamName:${code}`);
  await page.goto("/");
  const name = page.getByRole("textbox", { name: "チーム名" });

  await page.getByRole("textbox", { name: "チームコード 1桁目" }).click();
  await page.keyboard.type(code);
  await expect(name).toHaveValue("前回の班");

  // 最後の1桁を打ち直す。このコードには名前が残っていないので、欄は空に戻る。
  await page.keyboard.press("Backspace");
  await page.keyboard.type("8");
  await expect(name).toHaveValue("");
});

test("入室欄の誤りは送る前に止める", async ({ page }) => {
  let sessions = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/session")) sessions += 1;
  });
  await page.goto("/");
  await expect(enterButton(page)).toBeEnabled();

  await fillEntry(page, "12345", "A班");
  await enterButton(page).click();
  await expect(page.getByText("チームコードはASCII数字6桁で入力してください。")).toBeVisible();

  await page.getByRole("textbox", { name: "チーム名" }).fill("");
  await enterButton(page).click();
  await expect(page.getByText("チーム名を入力してください。")).toBeVisible();
  expect(sessions).toBe(0);
});

test("変換を確定する Enter（keyCode 229）では入室せず、次の Enter で入室する", async ({ page }) => {
  let sessions = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/session")) sessions += 1;
  });
  await page.goto("/");
  await expect(enterButton(page)).toBeEnabled();
  await fillEntry(page, uniqueTeamCode(), "発熱対策室");
  const name = page.getByRole("textbox", { name: "チーム名" });

  // Safari は変換確定の Enter を isComposing false・keyCode 229 で届ける。
  await name.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(enterButton(page)).toBeEnabled();
  await expect(page.getByText("入室しています…")).toHaveCount(0);
  expect(sessions).toBe(0);

  await name.press("Enter");
  await expect(welcomeHeading(page)).toBeVisible();
  expect(sessions).toBe(1);
});

test("API が答えなければエラーと［再試行］だけを出し、入室させない", async ({ page }) => {
  let down = true;
  await page.route("**/api/health", async (route) => {
    if (down) {
      await route.fulfill({ status: 503, body: "unavailable" });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByText("サーバに接続できません。ネットワークを確認して再試行してください。"),
  ).toBeVisible();
  await expect(enterButton(page)).toBeDisabled();
  // 台本モードへの逃げ道は作らない（#238 決定E）
  await expect(page.getByRole("button", { name: /オフライン/ })).toHaveCount(0);

  down = false;
  await retryButton(page).click();
  await expect(enterButton(page)).toBeEnabled();
  await expect(retryButton(page)).toHaveCount(0);
});
