import { expect, test, type Page } from "@playwright/test";

import { stage2AddendumMail } from "../../packages/content/src/index.js";
import { STAGE2_DEADLINE_MS, type Stage2Grid } from "../../packages/domain/src/index.js";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";
import { fakeStage2, modelGrid } from "./fake-stage2";

/*
 * Stage 2 の手作業ルート（V4-1）。Worker の代わりに fake-stage2 が答え、判定は domain の
 * judgeStage2。AI（台本・苅部さん・［表に送る］）は V4-2 なので、ここでは手で直す経路だけ。
 */

const grid = (page: Page) => page.getByTestId("s2-grid");
const cell = (page: Page, row: number, column: number) =>
  grid(page).locator(`input[data-r="${String(row)}"][data-c="${String(column)}"]`);
const size = (page: Page) => page.getByTestId("s2-size");
const verdict = (page: Page) => page.getByTestId("verdict");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Types every cell of `rows` into the grid, the way a team fixes the sheet by hand. */
const typeGrid = async (page: Page, rows: Stage2Grid): Promise<void> => {
  for (const [r, row] of rows.entries()) {
    for (const [c, value] of row.entries()) await cell(page, r, c).fill(value);
  }
};

/** The grid kept for a reload (sessionStorage `hellVueGrid:<code>`), put there before the page loads. */
const keepGrid = async (page: Page, code: string, startedAt: number, rows: Stage2Grid) => {
  const value = JSON.stringify({ startedAt, grid: rows, addendumIn: false });
  await page.addInitScript(
    ([key, text]) => {
      window.sessionStorage.setItem(key, text);
    },
    [`hellVueGrid:${code}`, value] as const,
  );
};

test("手作業で直して提出するとクリアし、交代の案内まで進む", async ({ page }) => {
  const fake = await fakeStage2(page, null);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "手作業班");

  await expect(page.getByTestId("s2-work")).toContainText("流行曲線が描けるよう");
  await expect(size(page)).toHaveText("22行 × 6列");
  await expect(page.getByTestId("mission-bar")).toContainText("7:00 申し送りまで");
  await expect(page.getByTestId("inbox-list")).toContainText("至急！！MRSAのやつまとめて");

  // 汚れたまま出すと差し戻し。空欄のセルが光り、［提出に戻る］で表に戻れる。
  await button(page, "提出する").click();
  await expect(verdict(page)).toContainText("✗ 必須列がすべて埋まっている");
  await expect(verdict(page)).toContainText("直して、もう一度提出してください。");
  await button(page, "提出に戻る").click();
  await expect(grid(page).locator("td.hot").first()).toBeVisible();

  // ノイズ行（空行と表題行）を消して、20行を手で打ち直す。
  await grid(page).getByRole("button", { name: "✕ 10" }).click();
  await grid(page).getByRole("button", { name: "✕ 1", exact: true }).click();
  await expect(size(page)).toHaveText("20行 × 6列");
  await typeGrid(page, modelGrid());
  await expect(grid(page).locator("td.hot")).toHaveCount(0);
  await button(page, "提出する").click();

  // 合格は4項目の ✓ とクリアの一行が判定枠に順に出て、出そろってからクリア演出に進む。
  await expect(verdict(page)).toContainText("✓ 行数が20行");
  await expect(verdict(page)).toContainText("Stage 2 をクリアしました");
  await expect(page.getByTestId("clear-unlock")).toHaveCount(0);
  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 2 をクリアしました");
  await expect(page.getByTestId("clear-field")).toBeVisible();
  await button(page, "次へ").click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();
  await page.waitForTimeout(500);
  await button(page, "次へ").click();
  await expect(page.getByTestId("clear-handover")).toContainText("操作する人を交代してください");
  expect(fake.types).toEqual(["s2.start", "s2.submit", "s2.submit"]);
});

test("締切を過ぎると追加分が届き、30行でないと通らない。［表に追加］で10行入る", async ({
  page,
}) => {
  // 締切（5分）と判定の猶予を過ぎている：20行ではもう通らない。
  const fake = await fakeStage2(page, STAGE2_DEADLINE_MS + 10_000);
  const code = uniqueTeamCode();
  const startedAt = fake.state().s2?.startedAt ?? 0;
  await keepGrid(page, code, startedAt, modelGrid());
  await page.goto("/");
  await enterTeam(page, code, "遅刻班");

  await expect(page.getByTestId("mission-countdown")).toHaveText("締切超過");
  await expect(size(page)).toHaveText("20行 × 6列");
  await button(page, "提出する").click();
  await expect(verdict(page)).toContainText(
    "✗ 行数が30行　→ 追加分10行がまだ表に入っていません（師長のメールの添付を開いて［表に追加］）",
  );
  await button(page, "提出に戻る").click();

  await page.getByTestId("inbox-list").getByText("すみません追加で").click();
  await expect(page.getByTestId("viewer-name")).toHaveText(stage2AddendumMail.attach);
  await page.getByTestId("s2-take").click();
  await expect(page.getByTestId("viewer")).toHaveCount(0);
  await expect(size(page)).toHaveText("30行 × 6列");

  // 取り込んだ後は［表に追加］を出さない（二重取り込みの防止）。
  await page.getByTestId("inbox-list").getByText("すみません追加で").click();
  await expect(page.getByTestId("viewer")).toBeVisible();
  await expect(page.getByTestId("s2-take")).toHaveCount(0);
  expect(fake.types).toEqual(["s2.submit", "s2.take-addendum"]);
});

/**
 * Records, from the page's start, every inbox row that ever carries `landing` (`window.landed`).
 * The class stays only 550 ms: catching it the moment it is set keeps the check off the speed of
 * the run.
 */
const recordLanding = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const landed: string[] = [];
    Object.assign(window, { landed });
    new MutationObserver(() => {
      for (const row of document.querySelectorAll<HTMLElement>(".mail.landing")) {
        const id = row.dataset["mailId"] ?? "";
        if (!landed.includes(id)) landed.push(id);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
};

const landedIds = (page: Page): Promise<unknown> =>
  page.evaluate((): unknown => Reflect.get(window, "landed"));

test("締切で届いた追加分は着弾で揺れ、再読み込みの後は揺らし直さない", async ({ page }) => {
  // 締切の1分前に入室し、入室時の受信トレイ（依頼の1通）を見てから時計を締切の先へ進める。
  await page.clock.install();
  await recordLanding(page);
  await fakeStage2(page, STAGE2_DEADLINE_MS - 60_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "着弾班");

  const list = page.getByTestId("inbox-list");
  const rows = list.getByRole("button");
  const addendum = rows.filter({ hasText: "すみません追加で" });
  await expect(rows).toHaveCount(1);
  const requestId = await rows.first().getAttribute("data-mail-id");

  await page.clock.fastForward(60_000);
  await expect(rows).toHaveCount(2);
  const addendumId = await addendum.getAttribute("data-mail-id");
  expect(addendumId).not.toBe(requestId);
  // 揺れたのは後から届いた追加分だけ（入室時からある依頼は揺れない）。
  await expect.poll(() => landedIds(page)).toEqual([addendumId]);
  // 揺れ終えたら外れる。
  await expect(list.locator(".mail.landing")).toHaveCount(0);

  // 再読み込み：時刻はサーバの時計に合わせ直されるので、サーバ側も締切を過ぎた状態で答えさせる
  // （後から登録した route が優先される）。追加分は初回の描画からあるので揺れない。
  await fakeStage2(page, STAGE2_DEADLINE_MS + 5_000);
  await page.reload();
  await expect(addendum).toBeVisible();
  await page.clock.fastForward(1_000);
  expect(await landedIds(page)).toEqual([]);
});

test("再読み込みしても直した表が残り、s2.start は送り直さない", async ({ page }) => {
  const fake = await fakeStage2(page, 60_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "再読込班");

  await cell(page, 2, 0).fill("002");
  await grid(page).getByRole("button", { name: "✕ 1", exact: true }).click();
  await expect(size(page)).toHaveText("21行 × 6列");

  await page.reload();
  await expect(size(page)).toHaveText("21行 × 6列");
  await expect(cell(page, 1, 0)).toHaveValue("002");
  expect(fake.types).toEqual([]);
});
