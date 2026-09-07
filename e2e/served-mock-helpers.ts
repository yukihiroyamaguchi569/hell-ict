import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 配信版モックの入口。参加者が当日触るのはReactハーネス（4173）ではなく、
 * scripts/build-testplay.sh が docs/ui/mock/index.html を加工して
 * apps/worker/public/ へ置き、WorkerのAssetsが同一オリジンで配るこちらである。
 */
export const SERVED_MOCK = "http://127.0.0.1:8787/";

/** 他テストと同じ部屋へ入らないよう、チームコードは毎回引き直す。 */
export const uniqueTeamCode = (): string =>
  String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

/**
 * 入室画面からLIVEで入室し、使ったチームコードを返す。コード欄は1桁ずつ6枠に
 * 分かれており、6枠ともaria-labelが「チームコード」なのでgetByLabelでは
 * 絞れない（DOM構造で指す）。［入室する］は起動時の /api/health プローブが
 * 終わるまでdisabledなので、clickの自動待機がそのままプローブ待ちになる。
 */
export const enterTeam = async (page: Page): Promise<string> => {
  const teamCode = uniqueTeamCode();
  const boxes = page.locator("#code input");
  for (const [index, digit] of teamCode.split("").entries()) {
    await boxes.nth(index).fill(digit);
  }
  await page.getByLabel("チーム名").fill("E2E班");
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.locator("#ov-entry")).toBeHidden();
  return teamCode;
};

/**
 * AIチャットへ1通送る。［送信］はAIチャット（#ai-send）と苅部さんのPHS窓
 * （#phs-send）の2つあるので、role+名前ではなくidで指す。
 */
export const sendToAi = async (page: Page, text: string): Promise<void> => {
  await page.getByLabel("AIへの指示").fill(text);
  await page.locator("#ai-send").click();
};

/**
 * LIVEの応答吹き出しを、改行とタブを保ったテキストへ戻す。
 *
 * LIVEの応答も、タブを含めば台本応答と同じ <pre class="tsv">
 * （white-space: pre）に入るようになった（sendAiLive()→liveReplyHtml()）。
 * このヘルパーは台本／LIVEのどちらの吹き出しからも本文を取れる汎用として
 * 残す——導入文（<br> 区切り）と表（<pre>）が混在しても、DOMから組み直して
 * 改行とタブをそのまま返す。
 */
export const bubbleText = (bubble: Locator): Promise<string> =>
  bubble.locator(".body").evaluate((element) => {
    const holder = document.createElement("div");
    holder.innerHTML = element.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    return holder.textContent ?? "";
  });

/** Stage 5：事務長メールを開いて添付ビューア（発熱患者一覧）を出す。 */
export const openFeverLinelist = async (page: Page): Promise<void> => {
  await page
    .locator("#mails button.mail")
    .filter({ hasText: "保健所への発熱患者一覧提出" })
    .click();
  await expect(page.locator("#ov-viewer")).toBeVisible();
  await expect(page.locator("#viewer-cols")).toBeVisible();
};

/** ビューアの列選択コピー／全文コピーを押し、クリップボードの中身を返す。 */
export const copyFromViewer = async (
  page: Page,
  button: "#btn-copy" | "#btn-copy-cols",
): Promise<string> => {
  await page.locator(button).click();
  await expect(page.locator(button)).toHaveText("コピーしました");
  await page.locator("#btn-viewer-close").click();
  await expect(page.locator("#ov-viewer")).toBeHidden();
  return page.evaluate(() => navigator.clipboard.readText());
};
