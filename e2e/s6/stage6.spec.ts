import { expect, test, type Page } from "@playwright/test";

import {
  stage6CopyReject,
  stage6JimuCall,
  stage6JimuMail,
  stage6Labels,
  stage6NoCandidateLines,
  stage6RejectType,
  stage6RequirementRejects,
} from "../../packages/content/src/index.js";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";
import { fakeStage6 as serveStage6, type FakeStage6 } from "./fake-stage6";

/** The fake of the running test: Stage 6 sent no command it must not, and never the AI chat. */
let served: FakeStage6 | null = null;
const fakeStage6 = async (page: Page): Promise<FakeStage6> => {
  served = await serveStage6(page);
  return served;
};
test.afterEach(() => {
  expect(served?.unexpected ?? []).toEqual([]);
  expect(served?.chatRequests ?? []).toEqual([]);
  served = null;
});

/*
 * Stage 6「掲示」。事務長の窓 → 右の AI に指示して候補を生成 → 候補を選ぶ → 提出 → 差し戻しか
 * クリア。AI は画面の台本で、会話はサーバの promptLog・candidates から描く（/game/chat/ は一度も
 * 呼ばない）。チームの状態と判定は page.route（fake-stage6.ts）、入室と疎通確認は本物の Worker。
 */

const task = (page: Page) => page.getByTestId("s6-task");
const chatInput = (page: Page) => page.getByRole("textbox", { name: "AIへの指示" });
const chatLog = (page: Page) => page.getByTestId("chat-log");
const candidate = (page: Page) => page.getByTestId("s6-candidate");
const submitButton = (page: Page) => page.getByRole("button", { name: stage6Labels.submit });
const pickButtons = (page: Page) => page.getByRole("button", { name: stage6Labels.pick });

const enterStage6 = async (page: Page): Promise<FakeStage6> => {
  const fake = await fakeStage6(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "S6班");
  await expect(task(page)).toContainText(stage6JimuCall.lines[0]);
  await task(page).getByRole("button", { name: stage6JimuCall.close }).click();
  await expect(task(page)).toHaveCount(0);
  return fake;
};

/** Sends an instruction and waits out the 2.5 s generation until its poster is in the chat. */
const generate = async (page: Page, prompt: string, posters: number): Promise<void> => {
  await chatInput(page).fill(prompt);
  await chatInput(page).press("Enter");
  await expect(chatLog(page)).toContainText(stage6Labels.generating);
  await expect(pickButtons(page)).toHaveCount(posters);
  await expect(chatLog(page)).not.toContainText(stage6Labels.generating);
};

const pickAndSubmit = async (page: Page, index: number): Promise<void> => {
  await pickButtons(page).nth(index).click();
  await expect(page.getByTestId("s6-thumb")).toBeVisible();
  await submitButton(page).click();
};

test("候補が無い間は［提出する］が押せない。生成待ちの後に候補が並び、選ぶと枠に入る", async ({
  page,
}) => {
  const fake = await enterStage6(page);
  await expect(candidate(page)).toContainText(stage6NoCandidateLines[0]);
  await expect(submitButton(page)).toBeDisabled();

  await chatInput(page).fill("ピクトグラムで面会制限のポスター");
  await chatInput(page).press("Enter");
  // The poster waits its 2.5 s behind the wait bubble, even once the server has answered.
  await expect(chatLog(page)).toContainText(stage6Labels.generating);
  await expect(pickButtons(page)).toHaveCount(0);
  await expect.poll(() => fake.candidates.length).toBe(1);
  await expect(pickButtons(page)).toHaveCount(1);
  await expect(page.getByTestId("chat-image")).toHaveAttribute("src", /pictogram/);

  await pickButtons(page).first().click();
  await expect(page.getByTestId("s6-thumb")).toHaveAttribute("src", /pictogram/);
  await expect(submitButton(page)).toBeEnabled();

  // The thumbnail opens enlarged, and closes from its ✕.
  await page.getByTestId("s6-thumb").click();
  await expect(page.getByTestId("s6-lightbox")).toBeVisible();
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByTestId("s6-lightbox")).toHaveCount(0);
});

test("メールの丸写しは送らずに差し戻す", async ({ page }) => {
  const fake = await enterStage6(page);
  await chatInput(page).fill(stage6JimuMail.body[1]);
  await chatInput(page).press("Enter");
  await expect(chatLog(page)).toContainText(stage6CopyReject);
  expect(fake.commands).toEqual([]);
  await expect(pickButtons(page)).toHaveCount(0);
});

test("差し戻しは理由ごとの近藤さんの文言。直して出し直すとクリアし、advance を1回だけ送る", async ({
  page,
}) => {
  const fake = await enterStage6(page);

  await generate(page, "去年と同じ文章のお知らせで", 1);
  await pickAndSubmit(page, 0);
  await expect(page.getByTestId("verdict")).toContainText(stage6RejectType.textheavy);

  await generate(page, "ピクトグラムで作って", 2);
  await pickAndSubmit(page, 1);
  await expect(page.getByTestId("verdict")).toContainText(stage6RequirementRejects.mask);

  await generate(page, "マスク着用のお願いも入れて", 3);
  await pickAndSubmit(page, 2);
  await expect(page.getByTestId("verdict")).toContainText(stage6RequirementRejects.visitingHours);

  await generate(page, "面会は14時から16時、15分以内と書いて", 4);
  await pickAndSubmit(page, 3);
  await expect(page.getByTestId("verdict")).toContainText(stage6Labels.cleared);
  await expect(page.getByTestId("verdict")).not.toContainText("テストプレイ");

  // ① → ② → ③. Stage 6 has no seat change (④): ③'s button is the last, and sends advance.
  await expect(page.getByTestId("clear-unlock")).toBeVisible();
  await expect(page.getByTestId("clear-field")).toBeVisible();
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByTestId("clear-handover")).toHaveCount(0);
  // The Final opens on the goal (e2e/final/ goes on from there).
  await expect(page.getByTestId("final-goal")).toBeVisible();
  await expect(page.getByTestId("coming-soon")).toHaveCount(0);

  expect(fake.commands.map((c) => c.type)).toEqual([
    "s6.generate",
    "s6.submit",
    "s6.generate",
    "s6.submit",
    "s6.generate",
    "s6.submit",
    "s6.generate",
    "s6.submit",
    "advance",
  ]);
  expect(fake.commands.at(-1)).toEqual(expect.objectContaining({ from: "s6", to: "final" }));
});

test("再読み込みすると会話と選んだ候補が戻り、事務長の窓は出ない", async ({ page }) => {
  const fake = await enterStage6(page);
  await generate(page, "多言語の掲示にして", 1);
  await generate(page, "ピクトグラムにして", 2);
  await pickButtons(page).nth(1).click();
  await expect(page.getByTestId("s6-thumb")).toHaveAttribute("src", /pictogram/);

  await page.reload();
  await expect(pickButtons(page)).toHaveCount(2);
  await expect(chatLog(page)).toContainText("多言語の掲示にして");
  await expect(chatLog(page)).toContainText("ピクトグラムにして");
  await expect(page.getByTestId("chat-image").first()).toHaveAttribute("src", /multilingual/);
  await expect(page.getByTestId("s6-thumb")).toHaveAttribute("src", /pictogram/);
  await expect(submitButton(page)).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(task(page)).toHaveCount(0);
  // Drawing the conversation again sends nothing: no second generation.
  expect(fake.commands.map((c) => c.type)).toEqual(["s6.generate", "s6.generate"]);
});

test("生成の応答を待つ間に再読み込みしても、同じ commandId で送り直して候補が出て、二重に作らない", async ({
  page,
}) => {
  const fake = await enterStage6(page);
  const release = fake.holdNextGenerate();
  await chatInput(page).fill("多言語の掲示にして");
  await chatInput(page).press("Enter");
  await expect(chatLog(page)).toContainText(stage6Labels.generating);
  await expect.poll(() => fake.commands.length).toBe(1);

  // The first send is still on its way: the Worker applies it only after the reload's read.
  await page.reload();
  await expect(chatLog(page)).toContainText("多言語の掲示にして");
  await expect(pickButtons(page)).toHaveCount(1);
  await expect(page.getByTestId("chat-image")).toHaveAttribute("src", /multilingual/);

  release();
  await expect.poll(() => fake.heldAnswered).toBe(true);
  const [first, again] = fake.commands;
  expect(fake.commands).toHaveLength(2);
  expect(again).toEqual(
    expect.objectContaining({ type: "s6.generate", commandId: first?.commandId }),
  );
  expect(fake.candidates).toEqual(["multilingual"]);
  await expect(pickButtons(page)).toHaveCount(1);
});

test("生成待ちの吹き出しに 2.5 秒で伸びきるバーが出て、候補が出たら消える", async ({ page }) => {
  const fake = await enterStage6(page);
  // Held until the bar is checked: the wait lasts however slow the machine is.
  const release = fake.holdNextGenerate();
  await chatInput(page).fill("ピクトグラムで面会制限のポスター");
  await chatInput(page).press("Enter");

  const bars = chatLog(page).getByTestId("chat-progress");
  const wait = chatLog(page)
    .getByTestId("chat-bubble")
    .filter({ hasText: stage6Labels.generating });
  await expect(wait.getByTestId("chat-progress")).toBeVisible();
  await expect(wait.getByTestId("chat-progress").locator("i")).toHaveCSS(
    "animation-duration",
    "2.5s",
  );
  // Only the wait has one: the team's own bubble does not.
  await expect(bars).toHaveCount(1);

  release();
  await expect(pickButtons(page)).toHaveCount(1);
  await expect(bars).toHaveCount(0);
  await expect(chatLog(page)).not.toContainText(stage6Labels.generating);
});
