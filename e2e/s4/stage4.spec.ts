import { expect, test, type Page } from "@playwright/test";

import {
  stage4ActionRejects,
  stage4DirectorMail,
  stage4DirectorPages,
  stage4QuestionLines,
  stage4SummaryReject,
  stage4ReportText,
} from "../../packages/content/src/index.js";
import { stage4Answers } from "../../packages/content/src/answers.js";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";
import { fakeStage4 as serveStage4, type FakeStage4 } from "./fake-stage4";

/** The fake of the running test: whatever it served, Stage 4 sent no command it must not. */
let served: FakeStage4 | null = null;
const fakeStage4 = async (page: Page): Promise<FakeStage4> => {
  served = await serveStage4(page);
  return served;
};
test.afterEach(() => {
  expect(served?.unexpected ?? []).toEqual([]);
  served = null;
});

/*
 * Stage 4「新情報の解釈」。院長の窓 → 受信トレイの論文 → 要約 → 院長との一往復 → クリアと交代の
 * 案内。チームの状態と判定は page.route（fake-stage4.ts）で、入室と疎通確認は本物の Worker。
 */

const SUMMARY_OK = stage4Answers.summaryOk;
const ACTION_OK = stage4Answers.actionOk;

const director = (page: Page) => page.getByTestId("s4-director");
const summaryBox = (page: Page) => page.getByRole("textbox", { name: "院長への要約" });
const actionBox = (page: Page) => page.getByRole("textbox", { name: "院長への返答" });
const talk = (page: Page) => page.getByTestId("s4-talk");

/** Each page of the director's window ignores presses for 400 ms: read it first. */
const readDirector = async (page: Page): Promise<void> => {
  await expect(director(page)).toContainText(stage4DirectorPages[0][0]);
  await page.waitForTimeout(500);
  await director(page).getByRole("button", { name: "次へ" }).click();
  await expect(director(page)).toContainText(stage4DirectorPages[1][1]);
  await page.waitForTimeout(500);
  await director(page).getByRole("button", { name: "了解しました" }).click();
  await expect(director(page)).toHaveCount(0);
};

const enterStage4 = async (page: Page) => {
  const fake = await fakeStage4(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "S4班");
  await readDirector(page);
  return fake;
};

const sendSummary = async (page: Page, text: string): Promise<void> => {
  await summaryBox(page).fill(text);
  await page.getByRole("button", { name: "院長へ報告" }).click();
};

test("院長の窓は連打で2ページ目を飛ばさない。受信トレイの1通から速報論文を開ける", async ({
  page,
}) => {
  await fakeStage4(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "S4班");
  await expect(director(page)).toContainText(stage4DirectorPages[0][0]);
  await page.waitForTimeout(500);
  await director(page).getByRole("button", { name: "次へ" }).dblclick();
  await expect(director(page)).toContainText("英語だ。要約して、私に上げなさい。");
  await page.waitForTimeout(500);
  await director(page).getByRole("button", { name: "了解しました" }).click();
  await expect(director(page)).toHaveCount(0);

  await page.getByRole("button", { name: /周辺国の速報論文/ }).click();
  await expect(page.getByTestId("viewer-name")).toHaveText(stage4DirectorMail.attach);
  // The paper's body, not just its title: its longest paragraph is in the viewer.
  const longestParagraph = stage4ReportText
    .split("\n")
    .reduce((longest, line) => (line.length > longest.length ? line : longest), "");
  expect(longestParagraph.length).toBeGreaterThan(80);
  await expect(page.getByTestId("viewer-text")).toContainText(longestParagraph);
});

test("要約と行動提案の差し戻しは理由ごとの文言。4種とも出る", async ({ page }) => {
  const fake = await enterStage4(page);
  await sendSummary(page, "発熱が続いています。");
  await expect(page.getByTestId("verdict")).toContainText(stage4SummaryReject);
  await expect(talk(page)).toHaveCount(0);

  await sendSummary(page, SUMMARY_OK);
  await expect(page.getByTestId("verdict")).toContainText("院長へ送信しました。");
  await expect(talk(page)).toContainText(stage4QuestionLines[2]);
  await expect(summaryBox(page)).not.toBeEditable();

  const cases = [
    [stage4Answers.actionAimedAtPatients, "aimed-at-patients"],
    [stage4Answers.actionMissingWhat, "missing-what"],
    [stage4Answers.actionMissingWhom, "missing-whom"],
    [stage4Answers.actionMissingBoth, "missing-both"],
  ] as const;
  for (const [text, reason] of cases) {
    await actionBox(page).fill(text);
    await talk(page).getByRole("button", { name: "送信する" }).click();
    await expect(talk(page).getByTestId("verdict")).toContainText(stage4ActionRejects[reason]);
  }
  expect(fake.commands.map((c) => c.type)).toEqual([
    "s4.submit-summary",
    "s4.submit-summary",
    ...cases.map(() => "s4.submit-action"),
  ]);
});

test("要約の受理後に再読み込みすると、要約の本文と院長との一往復が戻り、窓は出ない", async ({
  page,
}) => {
  await enterStage4(page);
  await sendSummary(page, SUMMARY_OK);
  await expect(talk(page)).toBeVisible();

  await page.reload();
  await expect(talk(page)).toContainText(stage4QuestionLines[0]);
  await expect(summaryBox(page)).toHaveValue(SUMMARY_OK);
  await expect(page.getByTestId("verdict").first()).toContainText("院長へ送信しました。");
  await page.waitForTimeout(500);
  await expect(director(page)).toHaveCount(0);
});

test("行動提案が通るとクリアの演出から交代の案内へ進み、advance を1回だけ送る", async ({
  page,
}) => {
  const fake = await enterStage4(page);
  await sendSummary(page, SUMMARY_OK);
  await actionBox(page).fill(ACTION_OK);
  await talk(page).getByRole("button", { name: "送信する" }).click();

  await expect(page.getByTestId("clear-unlock")).toBeVisible();
  await expect(page.getByTestId("clear-field")).toContainText("夜勤師長");
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByTestId("clear-exec")).toContainText("院長");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "次へ" }).click();
  const handover = page.getByTestId("clear-handover");
  await expect(handover).toContainText("操作する人を交代してください");
  await expect(handover).toContainText("交代のご案内は、これで最後です。");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "次へ" }).dblclick();

  await expect(page.getByTestId("s5-center")).toBeVisible();
  expect(fake.commands.filter((c) => c.type === "advance")).toEqual([
    expect.objectContaining({ from: "s4", to: "s5" }),
  ]);
});
