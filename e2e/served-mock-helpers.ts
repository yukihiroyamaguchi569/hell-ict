import { expect, type Page } from "@playwright/test";

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
 * 入室画面からLIVEで入室する。コード欄は1桁ずつ6枠に分かれており、6枠とも
 * aria-labelが「チームコード」なのでgetByLabelでは絞れない（DOM構造で指す）。
 * ［入室する］は起動時の /api/health プローブが終わるまでdisabledなので、
 * clickの自動待機がそのままプローブ待ちになる。
 */
export const enterTeam = async (page: Page): Promise<void> => {
  const boxes = page.locator("#code input");
  for (const [index, digit] of uniqueTeamCode().split("").entries()) {
    await boxes.nth(index).fill(digit);
  }
  await page.getByLabel("チーム名").fill("E2E班");
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.locator("#ov-entry")).toBeHidden();
};
