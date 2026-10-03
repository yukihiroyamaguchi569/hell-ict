import { expect, test, type Page } from "@playwright/test";

import {
  gameInstantSchema,
  gameViewResponseSchema,
  initialTeamGameState,
  INBOX_LIMIT_MS,
  DEADLINE_GRACE_MS,
  teamGameCommandSchema,
} from "../../packages/domain/src/index.js";
import { enterTeam, uniqueTeamCode, welcomeHeading } from "../shell/helpers";

/*
 * Prologue（受信トレイ）。1本目と3本目は本物の Worker、2本目は締切を page.clock で進めるため
 * GET /game とコマンドを page.route で受ける（サーバの時計は進められないため）。
 */

const row = (page: Page, id: string) => page.locator(`[data-mail-id="${id}"]`);
/** Any of the Prologue's three rows. */
const prologueRows = (page: Page) =>
  page.locator('[data-mail-id="p0"], [data-mail-id="p1"], [data-mail-id="p2"]');
const replyBox = (page: Page) => page.getByRole("textbox", { name: "返信" });
const sendButton = (page: Page) => page.getByRole("button", { name: "送信する" });
const s1Briefing = (page: Page) => page.getByTestId("s1-briefing");

const replyTo = async (page: Page, id: string, text: string): Promise<void> => {
  await row(page, id).click();
  await replyBox(page).fill(text);
  await sendButton(page).click();
  await expect(row(page, id)).toContainText("返信済み");
};

test("入室 →［メールを開く］→ 3通に返信 → Stage 1 のブリーフィング。Stage 1 以降に3通は出ない", async ({
  page,
}) => {
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");
  await page.getByRole("button", { name: "メールを開く" }).click();

  await expect(page.getByTestId("mission-bar")).toContainText("返信済み0 / 3");
  await expect(page.getByTestId("prologue-note")).toBeVisible();
  // 残り時間はメールを開いているときだけ。
  await expect(page.getByTestId("mission-countdown")).toHaveCount(0);
  await expect(page.getByTestId("inbox-list").getByRole("button")).toHaveCount(3);

  await row(page, "p0").click();
  await expect(page.getByTestId("mail-reader")).toContainText("人事課");
  await expect(page.getByTestId("mission-countdown")).toBeVisible();
  // 空欄なら送らず、ボタンの文言だけ一時的に変わる。
  await sendButton(page).click();
  await expect(page.getByRole("button", { name: "本文が空です" })).toBeVisible();
  await expect(sendButton(page)).toBeVisible();
  await expect(row(page, "p0")).not.toContainText("返信済み");

  await replyBox(page).fill("よろしくお願いします");
  await sendButton(page).click();
  await expect(row(page, "p0")).toContainText("返信済み");
  await expect(page.getByTestId("mission-bar")).toContainText("返信済み1 / 3");
  await replyTo(page, "p1", "承知しました");
  // The last reply clears the Prologue, and the screen moves on to Stage 1 by itself.
  await row(page, "p2").click();
  await replyBox(page).fill("発熱の件、確認します");
  await sendButton(page).click();

  await expect(s1Briefing(page)).toBeVisible();
  await expect(page.getByTestId("mission-bar")).toContainText("Stage 1");
  await expect(prologueRows(page)).toHaveCount(0);
  await page.reload();
  await expect(s1Briefing(page)).toBeVisible();
  await expect(prologueRows(page)).toHaveCount(0);
  await expect(welcomeHeading(page)).toHaveCount(0);

  // ［了解しました］で Stage 1 が始まり、引き継ぎメモと1通目が届く（本物の Worker）。
  await s1Briefing(page).click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(row(page, "memo")).toBeVisible();
  await expect(row(page, "m1")).toBeVisible();
  await expect(prologueRows(page)).toHaveCount(0);
});

test("書きかけは再読み込みで戻る", async ({ page }) => {
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");
  await page.getByRole("button", { name: "メールを開く" }).click();
  await row(page, "p2").click();
  await replyBox(page).fill("途中まで");
  await page.reload();
  await row(page, "p2").click();
  await expect(replyBox(page)).toHaveValue("途中まで");
});

/** A team whose inbox was opened just now, served from a fixed `GET /game`. */
const fakePrologue = async (page: Page) => {
  let skippedMs = 0;
  const serverNow = (): number => Date.now() + skippedMs;
  const initial = initialTeamGameState(gameInstantSchema.parse(new Date().toISOString()));
  const { processedCommandIds, ...game } = initial.game;
  void processedCommandIds;
  let state = { ...initial, game, inbox: { openedAt: serverNow(), sent: [] } };
  let pos = 0;
  const posted: string[] = [];
  const view = () =>
    gameViewResponseSchema.parse({ state, pos, serverNow: serverNow(), ai: { status: "none" } });

  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const command = teamGameCommandSchema.parse(route.request().postDataJSON());
    posted.push(command.type);
    const at = gameInstantSchema.parse(new Date(serverNow()).toISOString());
    if (command.type === "inbox.settle") {
      state = { ...state, game: { ...state.game, clearedAt: { prologue: at } } };
      pos = 1;
    } else if (command.type === "advance") {
      state = { ...state, game: { ...state.game, stage: "s1" }, enteredAt: { s1: at } };
    }
    await route.fulfill({ json: { status: "applied", events: [], judgement: null, ...view() } });
  });
  return {
    posted,
    skip: (ms: number) => {
      skippedMs += ms;
    },
  };
};

test("5分放置すると inbox.settle と advance を1回ずつ送って Stage 1 へ", async ({ page }) => {
  await page.clock.install();
  const server = await fakePrologue(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");
  await expect(page.getByTestId("prologue-note")).toBeVisible();

  await page.clock.fastForward(60_000);
  expect(server.posted).toEqual([]);

  const leftAlone = INBOX_LIMIT_MS + DEADLINE_GRACE_MS;
  server.skip(60_000 + leftAlone);
  await page.clock.fastForward(leftAlone);
  await expect(s1Briefing(page)).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(s1Briefing(page)).toBeVisible();
  expect(server.posted).toEqual(["inbox.settle", "advance"]);
});
