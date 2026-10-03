import { expect, test, type Locator, type Page } from "@playwright/test";

import { STAGE2_DEADLINE_MS } from "../../packages/domain/src/index.js";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";
import { fakeStage2 } from "./fake-stage2";

/*
 * Stage 2 の AI ルート（V4-2）。45 秒で苅部さんが鳴り、開くと右ペインが出る。台本 AI は
 * サーバへ送らず、返答の［表に送る］でグリッドへ流し込む。Worker の代わりは fake-stage2。
 */

const size = (page: Page) => page.getByTestId("s2-size");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const rightPane = (page: Page) => page.getByTestId("pane-right");
const chatInput = (page: Page) => page.getByRole("textbox", { name: "AIへの指示" });
const openKarube = (page: Page) => page.getByTestId("karube-phone").getByRole("button").last();

/** Every POST the screen made to the server's AI (the scripted AI must make none). */
const aiPosts = (page: Page): string[] => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/chat/messages")) {
      posts.push(request.url());
    }
  });
  return posts;
};

/** Pastes `text` into a cell, as the browser does for Ctrl+V. */
const pasteInto = async (page: Page, text: string): Promise<void> => {
  await page
    .getByTestId("s2-grid")
    .locator('input[data-r="0"][data-c="0"]')
    .evaluate((input, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
};

/** Asks the scripted AI and pours its table into the grid. */
const askAndSend = async (page: Page): Promise<void> => {
  await chatInput(page).fill("採取日と結果の書き方を揃えて");
  await chatInput(page).press("Enter");
  const reply = page.getByTestId("chat-bubble").filter({ hasText: "台本" });
  await expect(reply).toContainText("整形しました。「表に送る」で提出する表に入ります。");
  await reply.getByRole("button", { name: "表に送る" }).click();
};

test("苅部さんを開くと AI が出て、台本の［表に送る］でそのまま提出してクリアし、交代の案内まで進む", async ({
  page,
}) => {
  const posts = aiPosts(page);
  const fake = await fakeStage2(page, 50_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "AI班");

  await expect(page.getByTestId("karube-badge")).toHaveText("1");
  await expect(rightPane(page)).toHaveClass(/collapsed/);
  await openKarube(page).click();
  await expect(page.getByTestId("karube-log")).toContainText("また師長のExcelですか");
  await expect(rightPane(page)).not.toHaveClass(/collapsed/);
  // 読んだら閉じる。
  await openKarube(page).click();

  await askAndSend(page);
  await expect(size(page)).toHaveText("20行 × 6列");
  await button(page, "提出する").click();

  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 2 をクリアしました");
  await button(page, "次へ").click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();
  await page.waitForTimeout(500);
  await button(page, "次へ").click();
  await expect(page.getByTestId("clear-handover")).toContainText("操作する人を交代してください");
  expect(fake.types).toEqual(["s2.submit"]);
  expect(posts).toEqual([]);
});

/** Where an element sits on the page (the screen is scaled to fit, so compare like with like). */
const rect = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
  });

test("苅部さんのバーは画面の下端に付き、開いた窓はバーの真上に右端を揃えて付き、開閉でバーが動かない", async ({
  page,
}) => {
  await fakeStage2(page, 50_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "窓班");
  await expect(page.getByTestId("karube-badge")).toHaveText("1");

  const bar = openKarube(page);
  const closed = await rect(bar);
  const screen = await rect(page.locator(".screen"));
  expect(closed.bottom).toBeCloseTo(screen.bottom, 0);

  await bar.click();
  const win = page.getByTestId("karube-window");
  await expect(page.getByTestId("karube-log")).toContainText("また師長のExcelですか");
  const opened = await rect(bar);
  const shown = await rect(win);
  expect(opened).toEqual(closed);
  expect(shown.bottom).toBeCloseTo(opened.top, 0);
  expect(shown.right).toBeCloseTo(opened.right, 0);

  await bar.click();
  await expect(win).toHaveCount(0);
  expect(await rect(bar)).toEqual(closed);
});

test("締切を過ぎてから頼むと、台本の表は追加分込みの30行で、［表に追加］を押さずにそのまま提出できる", async ({
  page,
}) => {
  const fake = await fakeStage2(page, STAGE2_DEADLINE_MS + 10_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "遅刻AI班");

  await expect(page.getByTestId("mission-countdown")).toHaveText("締切超過");
  await openKarube(page).click();
  await expect(rightPane(page)).not.toHaveClass(/collapsed/);
  await openKarube(page).click();
  await askAndSend(page);
  await expect(size(page)).toHaveText("30行 × 6列");
  await button(page, "提出する").click();
  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 2 をクリアしました");
  expect(fake.types).toEqual(["s2.submit"]);
});

test("サーバの会話の準備に失敗していても、台本の返答と［表に送る］は出て使える", async ({
  page,
}) => {
  await fakeStage2(page, 50_000, { status: "failed" });
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "準備失敗班");

  await openKarube(page).click();
  await expect(rightPane(page)).not.toHaveClass(/collapsed/);
  await openKarube(page).click();
  await askAndSend(page);
  await expect(size(page)).toHaveText("20行 × 6列");
});

test("45 秒で鳴るまで AI は出ず、鳴っても開くまでは出ない。再読み込みで右ペインと表は戻り、会話は挨拶だけ", async ({
  page,
}) => {
  await fakeStage2(page, 43_000);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "再読込班");

  await expect(page.getByTestId("s2-work")).toBeVisible();
  await expect(page.getByTestId("karube-phone")).toHaveCount(0);
  await expect(rightPane(page)).toHaveClass(/collapsed/);
  await expect(page.getByTestId("karube-badge")).toHaveText("1", { timeout: 10_000 });
  await expect(rightPane(page)).toHaveClass(/collapsed/);
  await openKarube(page).click();
  await expect(rightPane(page)).not.toHaveClass(/collapsed/);

  // 複数行の貼り付けは［表に送る］と同じ処理。読めなければ理由を出し、表は変えない。
  await pasteInto(page, "区切りの無い\n二行");
  await expect(page.getByTestId("s2-paste-error")).toContainText("表として読めません");
  await expect(size(page)).toHaveText("22行 × 6列");
  await pasteInto(page, "001\t5A\t2026-07-01\t陽性\tあり\t\n002\t5A\t2026-07-02\t陰性\tなし\t");
  await expect(page.getByTestId("s2-paste-error")).toHaveCount(0);
  await expect(size(page)).toHaveText("2行 × 6列");

  await askAndSend(page);
  await expect(size(page)).toHaveText("20行 × 6列");

  await page.reload();
  await expect(size(page)).toHaveText("20行 × 6列");
  await expect(rightPane(page)).not.toHaveClass(/collapsed/);
  await expect(page.getByTestId("karube-badge")).toHaveCount(0);
  await expect(page.getByTestId("chat-bubble")).toHaveCount(1);
  await expect(page.getByTestId("chat-bubble").filter({ hasText: "台本" })).toHaveCount(0);
});
