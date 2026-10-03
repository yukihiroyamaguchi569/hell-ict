import { expect, test, type Page } from "@playwright/test";

import {
  stage5CallLines,
  stage5FeverRows,
  stage5IncidentReport,
  stage5ReportVerdicts,
  stage5ScoldLines,
  stage5SubmissionRejectLines,
} from "../../packages/content/src/index.js";
import { stage5Answers } from "../../packages/content/src/answers.js";
import { S5_FEVER_IDS } from "../../packages/domain/src/index.js";
import { uniqueTeamCode } from "../shell/helpers";
import { fakeStage5 as serveStage5, type FakeStage5, type FakeStage5Options } from "./fake-stage5";

/*
 * Stage 5「報告」。保健所への一覧の提出、AIへ個人情報を送りかけたときの罠（警報 → 事務長の叱責 →
 * 報告書の黒塗り）、回答期限の督促。チームの状態と判定は page.route（fake-stage5.ts）で、入室と
 * 疎通確認は本物の Worker。罠は Worker が決める: 画面は s5.check-ai-message を送らない。本物の
 * Worker と OpenAI スタブを通す経路は stage5-live.spec.ts。
 */

/** The fake of the running test: whatever it served, Stage 5 sent no command it must not. */
let served: FakeStage5 | null = null;
test.afterEach(() => {
  expect(served?.unexpected ?? []).toEqual([]);
  served = null;
});

const open = async (page: Page, options: FakeStage5Options = {}): Promise<FakeStage5> => {
  served = await serveStage5(page, uniqueTeamCode(), options);
  await page.goto("/");
  await expect(page.getByTestId("s5-center")).toBeVisible();
  return served;
};

/** A list that passes every check: all ids, one date style, every temperature with its unit. */
const GOOD_LIST = stage5Answers.cleanList;

/** The fever list's first row as it came: ID, name, ward, date and temperature. */
const PII_ROW = ((row) => [row.id, row.name, row.ward, row.date, row.temp].join("\t"))(
  stage5FeverRows[0],
);
/** The list pasted as it came, names and all: the trap. */
const PII_TEXT = `この一覧を整えてください\n${PII_ROW}`;

const list = (page: Page) => page.getByRole("textbox", { name: "保健所へ提出する一覧" });
const aiInput = (page: Page) => page.getByRole("textbox", { name: "AIへの指示" });
const pane = (page: Page) => page.getByTestId("chat-pane");
const report = (page: Page) => page.getByTestId("s5-report");
const lock = (page: Page) => page.getByTestId("penalty-lock");

const sendToAi = async (page: Page, text: string): Promise<void> => {
  await expect(pane(page)).toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  await aiInput(page).fill(text);
  await pane(page).getByRole("button", { name: "送信" }).click();
};

/** Whether each pressable segment of the report is personal data, in the order on screen. */
const PRESSABLE = stage5IncidentReport.flatMap((seg) => (seg.pii === undefined ? [] : [seg.pii]));

/** Presses the segments `pick` chooses among the pressable ones (`true`: personal data). */
const press = async (page: Page, pick: (pii: boolean) => boolean): Promise<void> => {
  const tokens = report(page).getByRole("button");
  await expect(tokens).toHaveCount(PRESSABLE.length);
  for (const [i, pii] of PRESSABLE.entries()) {
    if (pick(pii)) await tokens.nth(i).click();
  }
};

const submitReport = (page: Page) =>
  lock(page).getByRole("button", { name: "報告書を提出" }).click();

/** The session's stored values, joined: nothing of the personal data may be among them. */
const storedValues = (page: Page): Promise<string> =>
  page.evaluate(() =>
    Array.from({ length: sessionStorage.length }, (_, i) => {
      const key = sessionStorage.key(i);
      return key === null ? "" : `${key}=${sessionStorage.getItem(key) ?? ""}`;
    }).join("\n"),
  );

test("提出は差し戻しの理由を並べ、直した一覧でクリアの演出へ進む。期限はミッションバーに出る", async ({
  page,
}) => {
  const fake = await open(page);
  await expect(page.getByTestId("mission-bar")).toContainText("保健所の提出期限");
  await expect(page.getByTestId("mission-countdown")).toHaveText(/^0[12]:\d\d$/);

  await list(page).fill("005\t5A\t7/3\t38.1℃\n006\t5B\tR8.8.1\t３８.４℃");
  await page.getByRole("button", { name: "保健所へ提出" }).click();
  const verdict = page.getByTestId("verdict");
  const missing = S5_FEVER_IDS.filter((id) => id !== "005" && id !== "006");
  for (const line of stage5SubmissionRejectLines([{ reason: "ids", missingIds: missing }])) {
    await expect(verdict).toContainText(line);
  }
  await expect(page.getByTestId("s5-box")).toHaveClass(/warn/);

  await list(page).fill(GOOD_LIST);
  await page.getByRole("button", { name: "保健所へ提出" }).click();
  await expect(verdict).toContainText("Stage 5 をクリアしました");
  await expect(page.getByRole("button", { name: "保健所へ提出" })).toHaveCount(0);
  await expect(page.getByTestId("clear-unlock")).toBeVisible();
  expect(fake.count("s5.submit")).toBe(2);
  // The list is kept in memory only (user decision 4).
  expect(await storedValues(page)).not.toContain("005\t5A");
});

test("AIへ個人情報を送ると警報 → 叱責 → 黒塗りの罰。塗り方を直して出すと戻り、入力欄には本文が残る", async ({
  page,
}) => {
  const fake = await open(page);
  await sendToAi(page, PII_TEXT);

  await expect(page.getByTestId("s5-alarm")).toContainText("個人情報インシデント発生");
  const scold = page.getByTestId("s5-scold");
  await expect(scold).toBeVisible();
  for (const line of stage5ScoldLines) await expect(scold).toContainText(line);
  await expect(scold).toContainText("病院執行部");
  await scold.getByRole("button", { name: "了解しました" }).click();

  await expect(lock(page)).toContainText("罰ゲーム：報告書の作成");
  await expect(page.getByTestId("penalty-clock")).toBeVisible();
  // Nothing blacked out: personal data is left.
  await submitReport(page);
  await expect(lock(page).getByTestId("verdict")).toContainText(stage5ReportVerdicts.missing);
  // Only the words that are not personal data: both at once.
  await press(page, (pii) => !pii);
  await submitReport(page);
  await expect(lock(page).getByTestId("verdict")).toContainText(stage5ReportVerdicts.over);
  await expect(lock(page).getByTestId("verdict")).toContainText(stage5ReportVerdicts.missing);
  // Pressing every segment again undoes those and blacks out the personal data: through.
  await press(page, () => true);
  await submitReport(page);
  await expect(lock(page).getByTestId("verdict")).toContainText(stage5ReportVerdicts.sent);
  await expect(lock(page)).toHaveCount(0);

  // Back at the chat: the system bubble says it was blocked, the text is still in the input, and
  // it never showed as the team's own bubble.
  await expect(pane(page)).toContainText("個人情報を検知したため、送信をブロックしました。");
  await expect(aiInput(page)).toHaveValue(PII_TEXT);
  await expect(pane(page)).not.toContainText(stage5FeverRows[0].name);
  expect(await storedValues(page)).not.toContain(stage5FeverRows[0].name);
  expect(fake.count("s5.check-ai-message")).toBe(0);
  expect(fake.count("s5.submit-report")).toBe(3);
  expect(fake.penalty).toBe("done");
});

test("黒塗りの途中で再読み込みすると、警報と叱責は出ずに報告書が最初から出る", async ({ page }) => {
  const fake = await open(page);
  await sendToAi(page, PII_TEXT);
  await page.getByTestId("s5-scold").getByRole("button", { name: "了解しました" }).click();
  await press(page, (pii) => pii);
  await expect(report(page).getByRole("button", { pressed: true })).toHaveCount(
    PRESSABLE.filter(Boolean).length,
  );

  await page.reload();
  await expect(lock(page)).toBeVisible();
  await expect(page.getByTestId("s5-alarm")).toHaveCount(0);
  await expect(page.getByTestId("s5-scold")).toHaveCount(0);
  await expect(report(page).getByRole("button", { pressed: true })).toHaveCount(0);
  // Counted from the reload, not from the PC's clock: under 5 minutes, never the 10:xx of the
  // server's lead in these fixtures (a slow CI may take more than 10 seconds).
  await expect(page.getByTestId("penalty-clock")).toHaveText(/^0[0-4]:\d\d$/);

  await press(page, (pii) => pii);
  await submitReport(page);
  await expect(lock(page)).toHaveCount(0);
  expect(fake.count("s5.submit-report")).toBe(1);
});

test("2回目に個人情報を送っても罰は繰り返されず、ブロックの吹き出しだけが出る", async ({
  page,
}) => {
  const fake = await open(page, { penalty: "done" });
  await sendToAi(page, PII_TEXT);
  await expect(pane(page)).toContainText("個人情報を検知したため、送信をブロックしました。");
  await expect(aiInput(page)).toHaveValue(PII_TEXT);
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId("s5-alarm")).toHaveCount(0);
  await expect(page.getByTestId("s5-scold")).toHaveCount(0);
  await expect(lock(page)).toHaveCount(0);
  expect(fake.chatPosts).toEqual([PII_TEXT]);
  expect(fake.commands).toEqual([]);
});

test("回答期限を過ぎると事務長の督促が1回だけ出る。閉じたら再読み込みしても出ない", async ({
  page,
}) => {
  await open(page, { enteredAgoMs: 121_000 });
  await expect(page.getByTestId("mission-countdown")).toHaveText("回答期限超過");
  const call = page.getByTestId("s5-call");
  for (const line of stage5CallLines) await expect(call).toContainText(line);
  await call.getByRole("button", { name: "了解しました" }).click();
  await expect(call).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("s5-center")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(call).toHaveCount(0);
});

test("督促の内線と罰が重なったら、督促は罰の後に出る", async ({ page }) => {
  // The deadline passes 2 seconds after the trap, while the alarm and the scold are up.
  await open(page, { deadlineAfterTrapMs: 2_000 });
  await sendToAi(page, PII_TEXT);
  const scold = page.getByTestId("s5-scold");
  await expect(scold).toBeVisible();
  await expect(page.getByTestId("mission-countdown")).toHaveText("回答期限超過", {
    timeout: 12_000,
  });
  await expect(page.getByTestId("s5-call")).toHaveCount(0);
  await scold.getByRole("button", { name: "了解しました" }).click();
  await expect(lock(page)).toBeVisible();
  await expect(page.getByTestId("s5-call")).toHaveCount(0);

  await press(page, (pii) => pii);
  await submitReport(page);
  await expect(page.getByTestId("s5-call")).toBeVisible();
  await expect(lock(page)).toHaveCount(0);
});
