import { expect, test, type Page } from "@playwright/test";

import {
  acknowledgeStage1RoundResult,
  gameInstantSchema,
  gameViewResponseSchema,
  sendStage1Reply,
  settleStage1Round,
  startStage1,
  teamGameCommandSchema,
  type Stage1State,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";

/*
 * Stage 1 の画面。GET /game とコマンドを page.route で受け、domain の Stage 1 の規則で状態を
 * 進める（サーバの時計は進められないため）。実 Worker・実時間のラウンド遷移は journey（V3-4）。
 */

/** A reply the server takes as polite: 70 characters or more, with 「ます」. */
const POLITE =
  "お問い合わせいただきありがとうございます。確認のうえ、担当部署と調整して改めてご連絡いたしますので、恐れ入りますが今しばらくお待ちいただけますでしょうか。";

const R1 = ["m1", "m2", "m3", "m4", "m8"] as const;

/** A team in Stage 1 whose game the page reads from here. `s1: null`: the briefing is up. */
const fakeStage1 = async (page: Page, initial: Stage1State | null) => {
  const base = serverNow();
  let view = gameView("s1", false, base);
  let s1 = initial;
  const posted: string[] = [];
  const body = () =>
    gameViewResponseSchema.parse({ ...view, state: { ...view.state, s1 }, serverNow: serverNow() });

  const apply = (command: ReturnType<typeof teamGameCommandSchema.parse>): void => {
    const now = serverNow();
    // The five R1 mails land 0〜23 s after the start: starting 25 s back has them all in.
    if (command.type === "s1.start") s1 = startStage1(now - 25_000);
    if (s1 === null) return;
    if (command.type === "s1.reply")
      s1 = sendStage1Reply(s1, command.mailId, command.text, now).state;
    if (command.type === "s1.next-round") s1 = acknowledgeStage1RoundResult(s1, now) ?? s1;
    s1 = settleStage1Round(s1, now).state;
    if (s1.status.phase === "cleared") {
      const s1At = gameInstantSchema.parse(new Date(now).toISOString());
      const clearedAt = { ...view.state.game.clearedAt, s1: s1At };
      view = { ...view, pos: 3, state: { ...view.state, game: { ...view.state.game, clearedAt } } };
    }
  };

  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: body() });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const command = teamGameCommandSchema.parse(route.request().postDataJSON());
    posted.push(command.type);
    apply(command);
    await route.fulfill({ json: { status: "applied", events: [], judgement: null, ...body() } });
  });
  return { posted };
};

const row = (page: Page, id: string) => page.locator(`[data-mail-id="${id}"]`);
const replyBox = (page: Page) => page.getByRole("textbox", { name: "返信" });
const sendButton = (page: Page) => page.getByRole("button", { name: "送信する" });

test("ブリーフィング → R1 を5通返信してクリアの演出へ。Prologue の3通は出ない", async ({
  page,
}) => {
  const fake = await fakeStage1(page, null);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");

  const briefing = page.getByTestId("s1-briefing");
  await expect(briefing).toContainText("派遣の皆さん");
  // 画面のどこかを押せば残りが出て、［了解しました］が押せる。
  await briefing.click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(briefing).toHaveCount(0);
  expect(fake.posted).toEqual(["s1.start"]);

  const list = page.getByTestId("inbox-list");
  await expect(list.getByRole("button")).toHaveCount(6);
  await expect(list.getByRole("button").first()).toHaveAttribute("data-mail-id", "memo");
  await expect(page.locator('[data-mail-id^="p"]')).toHaveCount(0);
  await expect(page.getByTestId("inbox-unread")).toHaveText("5");

  // 空欄は送らず、ボタンの文言だけ一時的に変わる。
  await row(page, "m1").click();
  await expect(page.getByTestId("mission-countdown")).toBeVisible();
  await sendButton(page).click();
  await expect(page.getByRole("button", { name: "本文が空です" })).toBeVisible();
  expect(fake.posted).toEqual(["s1.start"]);

  for (const id of R1) {
    await row(page, id).click();
    await replyBox(page).fill(POLITE);
    await sendButton(page).click();
    if (id !== "m8") await expect(row(page, id)).toContainText("返信済み");
  }
  // クリアの演出より先に、結果窓（事務長は出ない）。
  const cleared = page.getByTestId("s1-clear");
  await expect(cleared).toContainText("受信トレイが落ち着きました");
  await expect(cleared).toContainText("苅部さんの手を借りず、この数を自力で捌き切りました。");
  await expect(cleared.locator("img")).toHaveCount(0);
  await expect(page.getByTestId("clear-unlock")).toHaveCount(0);
  await cleared.getByRole("button", { name: "確認した（次へ）" }).click();
  await expect(cleared).toHaveCount(0);
  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 1 をクリアしました");
  expect(fake.posted.filter((type) => type === "s1.reply")).toHaveLength(5);
});

test("R1 の失敗：結果窓にそっけない返信のスレッド、［確認した（次へ）］で2回目へ", async ({
  page,
}) => {
  // Two minutes in: every mail has landed and expired but m1, answered curtly.
  const started = serverNow() - 120_000;
  const s1 = settleStage1Round(
    sendStage1Reply(startStage1(started), "m1", "了解", started + 1_000).state,
    serverNow(),
  ).state;
  const fake = await fakeStage1(page, s1);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "B班");

  const result = page.getByTestId("s1-result");
  await expect(result).toContainText("1回目、終了");
  await expect(result).toContainText("1 / 5 件。");
  await expect(result).toContainText("4件、返信が来ていないと苦情が来ています。");
  await expect(result).toContainText("あなたの返信");
  await expect(result).toContainText("了解");
  await result.getByRole("button", { name: "確認した（次へ）" }).click();

  await expect(result).toHaveCount(0);
  await expect(page.getByTestId("mission-bar")).toContainText("2回目・AIあり");
  expect(fake.posted).toEqual(["s1.next-round"]);
  // 再読み込みしても結果窓は出ない（サーバはもう2回目）。
  await page.reload();
  await expect(page.getByTestId("mission-bar")).toContainText("2回目・AIあり");
  await expect(result).toHaveCount(0);
});

test("書きかけ（コンテキスト・要点・本文）は再読み込みで戻る", async ({ page }) => {
  const started = serverNow() - 10_000;
  const r2: Stage1State = { ...startStage1(started), round: 2 };
  await fakeStage1(page, r2);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "C班");

  await row(page, "r1").click();
  await page.getByRole("textbox", { name: "コンテキスト" }).fill("引き継ぎメモの一部");
  await page.getByRole("textbox", { name: "要点" }).fill("様式7で申請");
  await replyBox(page).fill("書きかけの返信");
  await expect(page.getByRole("button", { name: "AIに下書きさせる" })).toBeVisible();

  await page.reload();
  await row(page, "r1").click();
  await expect(page.getByRole("textbox", { name: "コンテキスト" })).toHaveValue(
    "引き継ぎメモの一部",
  );
  await expect(page.getByRole("textbox", { name: "要点" })).toHaveValue("様式7で申請");
  await expect(replyBox(page)).toHaveValue("書きかけの返信");
});
