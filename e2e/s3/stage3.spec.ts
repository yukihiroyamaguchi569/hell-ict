import { expect, test, type Page } from "@playwright/test";

import {
  missionTitles,
  stage3KarubeAfterTrap,
  stage3KarubeFinalPush,
  stage3KarubeLines,
  stage3FieldLabels,
  stage3KarubeTypeHint,
  stage3NoticeLines,
  stage3TrapDoctorLines,
  viewerDocs,
} from "../../packages/content/src/index.js";
import { stage3Answers } from "../../packages/content/src/answers.js";

import { enterTeam, uniqueTeamCode } from "../shell/helpers";
import { fakeStage3, type FakeStage3 } from "./fake-stage3";

/*
 * Stage 3 の画面。サーバの応答は fake-stage3.ts（page.route・判定は domain の judgeStage3）。
 * 入室と疎通確認は本物の Worker。
 */

const ANSWER = stage3Answers.ok;
/** 早見表を写しただけの欄。罠の語があり、打ち消す語が無い。 */
const TRAP_PPE = stage3Answers.contaminatedPpe;

const field = (page: Page, id: keyof typeof stage3FieldLabels) =>
  page.getByRole("textbox", { name: stage3FieldLabels[id] });
const submitButton = (page: Page) => page.getByRole("button", { name: "提出する" });
const call = (page: Page) => page.getByTestId("s3-call");
const lock = (page: Page) => page.getByTestId("penalty-lock");

let current: FakeStage3 | null = null;

test.afterEach(() => {
  expect(current?.unexpected ?? []).toEqual([]);
});

const enterStage3 = async (page: Page): Promise<FakeStage3> => {
  const game = await fakeStage3(page);
  current = game;
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "S3班");
  await expect(call(page)).toContainText(stage3NoticeLines[0]);
  // Not read to the end yet (了解しました not pressed): a reload brings it back.
  await page.reload();
  await expect(call(page)).toContainText(stage3NoticeLines[0]);
  await call(page).getByRole("button", { name: "了解しました" }).click();
  await expect(call(page)).toHaveCount(0);
  return game;
};

const MAILS = [
  ["s3shicho", viewerDocs.s3patients.name],
  ["s3kawai", viewerDocs.s3contaminated.name],
  ["s3lab", viewerDocs.s3lab.name],
] as const;

const fillAnswer = async (page: Page, ppe: string): Promise<void> => {
  await field(page, "ppe").fill(ppe);
  await field(page, "release").fill(ANSWER.release);
  await field(page, "clean").fill(ANSWER.clean);
};

/** Presses bottles one by one until the screen has reported the penalty paid. */
const fillEveryBottle = async (page: Page, game: FakeStage3): Promise<void> => {
  const waiting = page.getByTestId("bottle").and(page.locator(":enabled"));
  await expect
    .poll(
      async () => {
        if ((await waiting.count()) > 0) await waiting.first().click();
        return game.count("s3.finish-penalty");
      },
      { timeout: 25_000, intervals: [30] },
    )
    .toBe(1);
};

test("一報を閉じ、3通は viewer で開く。差し戻しは欄を指し、書きかけは再読み込みで残り、正答でクリア", async ({
  page,
}) => {
  const game = await enterStage3(page);

  const inbox = page.getByTestId("inbox-list");
  await expect(inbox.locator(".mail .from")).toHaveText([
    "3B病棟 看護師長",
    "医療安全管理室 カワイ",
    "検査科",
  ]);
  for (const [id, name] of MAILS) {
    await inbox.locator(`[data-mail-id="${id}"]`).click();
    await expect(page.getByTestId("viewer-name")).toHaveText(name);
    await page.getByRole("button", { name: "閉じる" }).click();
  }

  await fillAnswer(page, "標準予防策で対応する。");
  const release = game.holdNextSubmit();
  await submitButton(page).click();
  // While the answer is on its way, the fields stay as they were sent.
  await expect(page.getByTestId("verdict")).toContainText("提出を確認しています");
  await expect(field(page, "ppe")).not.toBeEditable();
  release();
  await expect(page.getByTestId("verdict")).toContainText("PPE・隔離の欄が、まだ足りません。");
  await expect(field(page, "ppe")).toBeEditable();
  await expect(page.getByTestId("s3-box-ppe")).toHaveClass(/warn/);

  await page.reload();
  await expect(field(page, "clean")).toHaveValue(ANSWER.clean);
  await expect(call(page)).toHaveCount(0);

  await field(page, "ppe").fill(ANSWER.ppe);
  await submitButton(page).click();
  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 3 をクリアしました");
  expect(game.count("s3.submit")).toBe(2);
  expect(game.count("s3.finish-penalty")).toBe(0);

  // The clear effect's last sheet sends advance {s3→s4} once, and Stage 3 leaves the screen.
  // What Stage 4 then shows is its own test's business (e2e/s4/).
  const next = page.getByRole("button", { name: "次へ" });
  await expect(page.getByTestId("clear-field")).toBeVisible();
  await page.waitForTimeout(500);
  await next.click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();
  await page.waitForTimeout(500);
  await next.dblclick();
  await expect(page.getByTestId("mission-bar")).toContainText(missionTitles.s4);
  await expect(field(page, "ppe")).toHaveCount(0);
  expect(game.count("advance")).toBe(1);
});

test("罠の初回は暗転→皮膚科医→罰。罰の途中で再読み込みしても棚は最初からで、補充し終えるまで提出できない。2回目の罠で罰は繰り返さない", async ({
  page,
}) => {
  const game = await enterStage3(page);
  await fillAnswer(page, TRAP_PPE);
  await submitButton(page).click();

  await expect(page.getByTestId("s3-blackout")).toBeVisible();
  await expect(call(page)).toContainText(stage3TrapDoctorLines[0]);
  await call(page).getByRole("button", { name: "了解しました" }).click();
  await expect(lock(page)).toContainText("罰ゲーム：🧴 消毒液ボトルの補充");

  const waiting = page.getByTestId("bottle").and(page.locator(":enabled"));
  await waiting.first().click();
  await expect(page.getByTestId("bottle-stat")).toHaveText("済 1 / 全 20 本");

  await page.reload();
  await expect(lock(page)).toBeVisible();
  await expect(page.getByTestId("s3-blackout")).toHaveCount(0);
  await expect(call(page)).toHaveCount(0);
  await expect(page.getByTestId("bottle-stat")).toHaveText("済 0 / 全 20 本");
  // The penalty's clock starts over at 0, not at the PC's lag behind the server (10 minutes).
  // Anything under 5 minutes tells the two apart, however slow the machine.
  await expect(page.getByTestId("penalty-clock")).toHaveText(/^0[0-4]:\d\d$/);
  // The lock covers the form: the submit button cannot be pressed.
  await expect(submitButton(page).click({ timeout: 1_000 })).rejects.toThrow();
  expect(game.count("s3.submit")).toBe(1);

  await fillEveryBottle(page, game);
  await expect(lock(page)).toHaveCount(0);
  await expect(field(page, "ppe")).toHaveValue(TRAP_PPE);

  await submitButton(page).click();
  await expect(page.getByTestId("verdict")).toContainText(
    "まだ基準が正しくありません。院内感染対策マニュアルを確認してください。",
  );
  await expect(page.getByTestId("s3-blackout")).toHaveCount(0);
  await expect(lock(page)).toHaveCount(0);
  expect(game.count("s3.submit")).toBe(2);
  expect(game.count("s3.finish-penalty")).toBe(1);
});

const badge = (page: Page) => page.getByTestId("karube-badge");
const karubeLog = (page: Page) => page.getByTestId("karube-log");
const togglePhone = (page: Page) =>
  page
    .getByTestId("karube-phone")
    .getByRole("button", { name: /メッセージ/ })
    .click();

/** Opens the phone, checks that it ends with `last`, and closes it again. */
const readPhone = async (page: Page, last: string): Promise<void> => {
  await togglePhone(page);
  await expect(karubeLog(page).locator("p").last()).toHaveText(last);
  await togglePhone(page);
  await expect(badge(page)).toHaveCount(0);
};

/** Sends the (trapped) fields again and waits until the answer is on screen. */
const submitAgain = async (page: Page, game: FakeStage3, count: number): Promise<void> => {
  await submitButton(page).click();
  await expect.poll(() => game.count("s3.submit")).toBe(count);
  await expect(field(page, "ppe")).toBeEditable();
  await expect(page.getByTestId("verdict")).toContainText("まだ基準が正しくありません。");
};

test("苅部さん: 差し戻しで2行、罰明けに「出ましたか」、罠の2・3回目に病型のヒント、4回目にだめ押し。既読は再読み込みで鳴らし直さない", async ({
  page,
}) => {
  const game = await enterStage3(page);
  await expect(page.getByTestId("karube-phone")).toHaveCount(0);

  await fillAnswer(page, "標準予防策で対応する。");
  await submitButton(page).click();
  await expect(badge(page)).toHaveText("1");
  await readPhone(page, stage3KarubeLines[1]);

  await field(page, "ppe").fill(TRAP_PPE);
  await submitButton(page).click();
  await call(page).getByRole("button", { name: "了解しました" }).click();
  await fillEveryBottle(page, game);
  await expect(lock(page)).toHaveCount(0);
  await expect(badge(page)).toHaveText("2");
  await readPhone(page, stage3KarubeAfterTrap);

  await submitAgain(page, game, 3);
  await expect(badge(page)).toHaveText("3");
  await readPhone(page, stage3KarubeTypeHint[1]);

  // Read calls neither ring nor badge again after a reload; the phone shows them all at once.
  await page.reload();
  await expect(page.getByTestId("karube-phone")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await togglePhone(page);
  await expect(karubeLog(page).locator("p")).toHaveCount(5);
  await togglePhone(page);

  await submitAgain(page, game, 4);
  await expect(badge(page)).toHaveText("4");
  await readPhone(page, stage3KarubeTypeHint[1]);
  await submitAgain(page, game, 5);
  await expect(badge(page)).toHaveText("5");
  await readPhone(page, stage3KarubeFinalPush[1]);

  // The 5th trap judgement brings nothing more.
  await submitAgain(page, game, 6);
  await expect(badge(page)).toHaveCount(0);
});
