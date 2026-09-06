import { expect, test, type Page } from "@playwright/test";

/**
 * 配信版モックのE2E。参加者が当日触るのはReactハーネス（4173）ではなく、
 * scripts/build-testplay.sh が docs/ui/mock/index.html を加工して
 * apps/worker/public/ へ置き、WorkerのAssetsが同一オリジンで配るこちらである。
 * 加工（開発用UIを隠すstyle・#devbarトグル・画像パスの書き換え）と、
 * 加工後にだけ通る起動経路（LIVEの入室）は、ここでしか検証できない。
 * ビルドの前段化は playwright.config.ts のworker webServerコメントを参照。
 */
const SERVED_MOCK = "http://127.0.0.1:8787/";

/** 他テストと同じ部屋へ入らないよう、チームコードは毎回引き直す。 */
const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

/**
 * 入室画面からLIVEで入室する。コード欄は1桁ずつ6枠に分かれており、6枠とも
 * aria-labelが「チームコード」なのでgetByLabelでは絞れない（DOM構造で指す）。
 * ［入室する］は起動時の /api/health プローブが終わるまでdisabledなので、
 * clickの自動待機がそのままプローブ待ちになる。
 */
const enterTeam = async (page: Page): Promise<void> => {
  const boxes = page.locator("#code input");
  for (const [index, digit] of uniqueTeamCode().split("").entries()) {
    await boxes.nth(index).fill(digit);
  }
  await page.getByLabel("チーム名").fill("E2E班");
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.locator("#ov-entry")).toBeHidden();
};

/**
 * Stage 4 の開始演出（院長のタスク付与オーバーレイ）を閉じる。台詞は2画面あり、
 * 描き直した直後の押下は連打対策（S4_DIRECTOR_PAGE_GRACE_MS＝400ms）で捨てられる
 * ため、閉じるまで押し直す。
 */
const dismissS4Director = async (page: Page): Promise<void> => {
  const overlay = page.locator("#ov-s4-director");
  await expect(overlay).toBeVisible();
  const close = page.locator("#btn-s4director-close");
  for (let attempt = 0; attempt < 8 && (await overlay.isVisible()); attempt += 1) {
    await close.click();
    await page.waitForTimeout(450);
  }
  await expect(overlay).toBeHidden();
};

test.describe("配信版モック", () => {
  test("ハッシュ無しで開くと、開発用の枠が出ず例外も起きない", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(SERVED_MOCK);
    await expect(page.locator("#ov-entry")).toBeVisible();

    // 解説（.caption）は罠の種明かしそのもの、ジャンプ引き出し（.jump）と
    // 開発用スイッチャ（.devbar）はステージ飛ばしの導線。参加者の画面に出せない。
    for (const selector of [".masthead", ".devbar", ".caption", ".jump"]) {
      await expect(page.locator(selector)).toBeHidden();
    }

    expect(pageErrors).toEqual([]);
  });

  test("#devbar を付けて開くと開発用の枠が出て、ハッシュは消える", async ({ page }) => {
    await page.goto(`${SERVED_MOCK}#devbar`);

    await expect(page.locator(".devbar")).toBeVisible();
    await expect(page.locator(".masthead")).toBeVisible();
    // 同じ操作を何度でも繰り返せるよう、押した後にハッシュを捨てる。
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  });

  test("ステージ指定のハッシュで開いても、先に入室してから指定ステージへ飛ぶ", async ({ page }) => {
    await page.goto(`${SERVED_MOCK}#s4`);

    // 入室を飛ばすと liveState が空のまま進み、AIチャットが全部台本応答に落ちる
    // （2026-09-06 に実際に起きた取り違え）。ハッシュ指定でも入室は必ず挟む。
    await expect(page.locator("#ov-entry")).toBeVisible();
    await expect(page.locator(".stage-title")).toHaveCount(0);

    await enterTeam(page);

    // 預けたハッシュは入室成功後に消費される（Prologueではなく指定ステージへ）。
    await expect(page.locator(".stage-title")).toHaveText("Stage 4　新情報の解釈");
  });

  test("LIVEで入室してAIへ送ると、実API経由の応答が「台本」ラベル無しで返る", async ({ page }) => {
    await page.goto(`${SERVED_MOCK}#s4`);
    await enterTeam(page);
    await dismissS4Director(page);

    await page.getByLabel("AIへの指示").fill("速報論文を要約してください");
    await page.getByRole("button", { name: "送信" }).click();

    const reply = page
      .locator("#ai-log .bubble")
      .filter({ hasText: "（スタブ応答）承知しました。" });
    await expect(reply).toBeVisible();
    // 台本応答にだけ付く目印。実API（sendAiLive）の応答へ付いていたら、
    // 入室が効かず台本へ落ちている。
    await expect(reply.locator(".tag")).toHaveCount(0);
    await expect(page.locator("#ai-log .bubble.scripted")).toHaveCount(0);
  });

  test("本番画像が配信ルート直下のパスで返る", async ({ page }) => {
    // モックは "../../../assets/..." で画像を参照している。build-testplay.sh の
    // sed が配信ルート基準へ書き換えられていなければ、当日の画像が全部404になる。
    const html = await page.request.get(SERVED_MOCK);
    expect(html.status()).toBe(200);
    expect(await html.text()).not.toContain("../../../assets/");

    const image = await page.request.get(
      `${SERVED_MOCK}assets/images/production/stage1-administrative-director.png`,
    );
    expect(image.status()).toBe(200);
  });
});
