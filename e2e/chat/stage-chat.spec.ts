import { expect, test, type Page } from "@playwright/test";

import { uniqueTeamCode } from "../shell/helpers";
import { fakeStageChat, message, refuse, S3, S4 } from "./fake-stage-chat";

/*
 * Stage 3 の右ペイン（AIチャット）。ステージの状態とチャットは page.route の固定応答で、
 * 送信の失敗・再送・再読み込み・ステージの切り替えを1つずつ起こす。本物の Worker と
 * OpenAI スタブを通す経路は stage-chat-live.spec.ts。
 */

const pane = (page: Page) => page.getByTestId("chat-pane");
const input = (page: Page) => page.getByRole("textbox", { name: "AIへの指示" });
const sendButton = (page: Page) => pane(page).getByRole("button", { name: "送信" });

const PENDING_KEY_PREFIX = "hellStageChatPending:";

const send = async (page: Page, text: string): Promise<void> => {
  await input(page).fill(text);
  await sendButton(page).click();
};

const open = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(pane(page)).toBeVisible();
  await expect(pane(page)).toContainText("AIアシスタント");
};

test("挨拶で始まり、送った発言とAIの応答が並ぶ。表の応答はタブを保つ", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.answer = async (route, body) => {
    await route.fulfill({
      json: fake.reply(String(body.text), "整えました。\n患者ID\t病棟\nA-01\t5A\nA-02\t5B"),
    });
  };
  await open(page);
  await expect(pane(page)).toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  // 前のステージ（S2）の会話は出さない。
  await expect(pane(page)).not.toContainText("前のステージの質問");

  await send(page, "一覧を表にして");
  await expect(input(page)).toHaveValue("");
  await expect(pane(page)).toContainText("整えました。");
  await expect(pane(page)).not.toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  const table = pane(page).locator("pre.tsv");
  await expect(table).toHaveText("患者ID\t病棟\nA-01\t5A\nA-02\t5B");
  expect(fake.posts).toEqual([
    {
      type: "stage-message",
      commandId: expect.any(String),
      generation: expect.any(Number),
      text: "一覧を表にして",
    },
  ]);
});

test("429 は待ち時間を告げ、本文を入力欄へ戻す。自分からは送り直さない", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.answer = (route) => refuse(route, 429, { message: "多すぎます。" }, { "Retry-After": "17" });
  await open(page);
  await send(page, "質問");
  await expect(pane(page)).toContainText(
    "送信が多すぎます。17 秒待ってからもう一度送ってください。",
  );
  await expect(input(page)).toHaveValue("質問");
  await expect(input(page)).toBeEditable();
  await page.waitForTimeout(500);
  expect(fake.posts).toHaveLength(1);
});

test("503 のあと押し直すと同じ commandId で送る", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.answer = (route) => refuse(route, 503, { message: "時間を置いて再試行してください。" });
  await open(page);
  await send(page, "質問");
  await expect(pane(page)).toContainText("AIの応答を取得できませんでした。再試行してください。");
  await expect(input(page)).toHaveValue("質問");
  // 保存されたか分からないので、GET /chat で描き直す（入室の1回＋1回）。
  expect(fake.chatGets).toHaveLength(2);

  fake.answer = async (route, body) => {
    await route.fulfill({ json: fake.reply(String(body.text)) });
  };
  await sendButton(page).click();
  await expect(pane(page)).toContainText("回答: 質問");
  expect(fake.posts).toHaveLength(2);
  expect(fake.posts[1]?.commandId).toBe(fake.posts[0]?.commandId);
});

test("422 pii_blocked のあとは、同じ本文でも新しい commandId で送る", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.answer = (route) =>
    refuse(route, 422, { message: "個人情報を検知しました。", code: "pii_blocked" });
  await open(page);
  await send(page, "090-0000-5678 の方の件");
  await expect(pane(page)).toContainText("個人情報を検知したため、送信をブロックしました。");
  await expect(input(page)).toHaveValue("090-0000-5678 の方の件");
  await sendButton(page).click();
  await expect.poll(() => fake.posts.length).toBe(2);
  expect(fake.posts[1]?.commandId).not.toBe(fake.posts[0]?.commandId);
});

test("変換を確定する Enter（keyCode 229）では送らず、次の Enter で送る", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  await open(page);
  await input(page).fill("質問");

  // Safari は変換確定の Enter を isComposing false・keyCode 229 で届ける。
  await input(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(input(page)).toHaveValue("質問");
  expect(fake.posts).toHaveLength(0);

  await input(page).press("Enter");
  await expect(pane(page)).toContainText("回答: 質問");
  expect(fake.posts).toHaveLength(1);
});

test("送信中は入力と送信を塞ぎ、ダブルクリックしても POST は1回", async ({ page }) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.answer = async (route, body) => {
    await held;
    await route.fulfill({ json: fake.reply(String(body.text)) });
  };
  await open(page);
  await input(page).fill("質問");
  await sendButton(page).dblclick();
  await expect(pane(page)).toContainText("AIが入力中…");
  await expect(input(page)).toBeDisabled();
  await expect(sendButton(page)).toBeDisabled();
  await page.keyboard.press("Enter");
  release();
  await expect(pane(page)).toContainText("回答: 質問");
  await expect(pane(page)).not.toContainText("AIが入力中…");
  expect(fake.posts).toHaveLength(1);
});

test("再読み込みでは未確定IDを GET /chat?commandIds= で突き合わせ、processed は捨てる", async ({
  page,
}) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  // 応答が届かない（接続が切れた）: 保存されたか分からないのでIDを持ち越す。
  fake.answer = (route) => route.abort("connectionreset");
  await open(page);
  await send(page, "質問");
  await expect(pane(page)).toContainText("AIの応答を取得できませんでした。再試行してください。");
  const firstId = String(fake.posts[0]?.commandId);
  const stored = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    PENDING_KEY_PREFIX + code,
  );
  expect(stored).toContain(firstId);

  // サーバでは処理済みだった。再読み込みで突き合わせ、そのIDを捨てる。
  fake.commands = { [firstId]: "processed" };
  fake.threads[S3] = [message("user", "質問"), message("assistant", "回答: 質問")];
  fake.revision += 1;
  await page.reload();
  await expect(pane(page)).toContainText("回答: 質問");
  expect(fake.chatGets.at(-1)).toBe(
    `/api/teams/${code}/chat?commandIds=${encodeURIComponent(firstId)}`,
  );
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY_PREFIX + code))
    .toBeNull();

  // 同じ本文をもう一度送るのは新しい発言：新しいIDで送る。
  fake.answer = async (route, body) => {
    await route.fulfill({ json: fake.reply(String(body.text)) });
  };
  await send(page, "質問");
  await expect.poll(() => fake.posts.length).toBe(2);
  expect(fake.posts[1]?.commandId).not.toBe(firstId);
});

test("ステージが変わると前の会話とお知らせが消え、無いスレッドは前の会話へ落ちずに空で出す", async ({
  page,
}) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.threads[S3] = [message("user", "Stage 3 の質問"), message("assistant", "Stage 3 の回答")];
  fake.answer = (route) => refuse(route, 503, { message: "時間を置いて再試行してください。" });
  await open(page);
  await expect(pane(page)).toContainText("Stage 3 の回答");
  await send(page, "もう一つ");
  await expect(pane(page)).toContainText("AIの応答を取得できませんでした。");

  // 次のステージへ（GET /game が別のスレッドを名指す）。/chat はまだそのスレッドを持たない。
  fake.ai = { status: "ready", threadId: S4, live: true };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(pane(page)).toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  await expect(pane(page)).not.toContainText("Stage 3 の回答");
  await expect(pane(page)).not.toContainText("AIの応答を取得できませんでした。");
  // 無いスレッドは取りに行く（入室・503 の描き直し・切り替えの3回）。
  await expect.poll(() => fake.chatGets.length).toBe(3);
});

test("会話の準備に失敗したら［再試行］で POST chat/thread を送り、整えば送れる", async ({
  page,
}) => {
  const code = uniqueTeamCode();
  const fake = await fakeStageChat(page, code);
  fake.ai = { status: "failed" };
  fake.prepare = () => ({ status: "ready", threadId: S3, live: true });
  await open(page);
  await expect(pane(page)).toContainText("会話の準備に失敗しました。");
  await expect(input(page)).toBeDisabled();
  await pane(page).getByRole("button", { name: "再試行" }).click();
  await expect(pane(page)).toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  expect(fake.prepares).toEqual([{ type: "prepare-stage-thread", generation: expect.any(Number) }]);
  await expect(input(page)).toBeEditable();
});
