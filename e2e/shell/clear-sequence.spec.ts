import { expect, test, type Locator, type Page } from "@playwright/test";

import { stageClears, stageEntryBands } from "../../packages/content/src/index.js";
import {
  GAME_STAGE_IDS,
  gameCommandResponseSchema,
  gameStagePosition,
  gameViewResponseSchema,
} from "../../packages/domain/src/index.js";
import { gameView, type PLAYED, serverNow } from "./game-view";
import { enterTeam, uniqueTeamCode } from "./helpers";

/*
 * クリアの3段演出（①告知→②現場→③幹部→S2/S4 だけ④交代）と、最後の advance。ステージの中身は
 * まだ無い（V2 以降）ので、`GET /api/teams/:code/game` を schema に通した固定の状態で差し替え、
 * クリア済み・advance 未送信の場面から始める。入室（/api/session）と疎通確認は本物の Worker。
 *
 * 未実装のステージ（apps/web/src/stages/<id>/index.ts が null）はクリア済みでも演出を出さず
 * advance も送らない（Vitest: apps/web/test/app-view.test.ts の clearEffectScene）。S1〜S3 はまだ未実装なので、各テストは
 * そのステージが登録されるまで fixme にしておく（S1 は V3、S2 は V4、S3 は V5 で外す）。
 */

interface FakeGame {
  /** The body `GET /game` answers with now. */
  view: ReturnType<typeof gameView>;
  /** Every `advance` the screen posted. */
  readonly advances: unknown[];
}

/**
 * Serves the team's game from `game.view`. `advance` from the cleared stage is applied once:
 * the team enters the next stage and the answer carries `stage-entered`. Any other command (the
 * next stage's own, once that stage is built) is refused without changing anything, so these
 * tests do not depend on what the next stage sends.
 */
const fakeGame = async (page: Page, stage: (typeof PLAYED)[number]): Promise<FakeGame> => {
  const base = serverNow();
  const game: FakeGame = { view: gameView(stage, true, base), advances: [] };
  const next = GAME_STAGE_IDS[gameStagePosition(stage) + 1] ?? "final";
  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({
      json: gameViewResponseSchema.parse({ ...game.view, serverNow: serverNow() }),
    });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (typeof body !== "object" || body === null || !("type" in body) || body.type !== "advance") {
      await route.fulfill({
        json: gameCommandResponseSchema.parse({
          status: "rejected",
          reason: "stage-mismatch",
          judgement: null,
          ...game.view,
          serverNow: serverNow(),
        }),
      });
      return;
    }
    game.advances.push(body);
    game.view = gameView(next, false, base);
    const answer = gameCommandResponseSchema.parse({
      status: "applied",
      events: [{ type: "stage-entered", stage: next, at: new Date(serverNow()).toISOString() }],
      judgement: null,
      ...game.view,
    });
    await route.fulfill({ json: answer });
  });
  return game;
};

/** A MM:SS readout in seconds. */
const mmssSeconds = async (readout: Locator): Promise<number> => {
  const text = await readout.innerText();
  const match = /^(\d\d):(\d\d)$/.exec(text);
  if (match === null) throw new Error(`clock shows ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
};

const screen = (page: Page) => page.locator(".screen");

/** ②③ show their full-screen picture from the Worker: the right file, actually loaded. */
const expectArt = async (sheet: Locator, file: string): Promise<void> => {
  const art = sheet.locator("img.art");
  await expect(art).toHaveAttribute("src", `/assets/images/production/${file}`);
  await expect
    .poll(() => art.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
};
const nextButton = (page: Page) => page.getByRole("button", { name: "次へ" });

/** ③④ ignore clicks for 400 ms after opening; wait them out as a reader would. */
const readAndNext = async (page: Page): Promise<void> => {
  await page.waitForTimeout(500);
  await nextButton(page).click();
};

test("Stage 2 のクリア：①→②→③→④交代→advance は1回、赤帯と crisis へ", async ({ page }) => {
  const game = await fakeGame(page, "s2");
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "A班");

  const unlock = page.getByTestId("clear-unlock");
  await expect(unlock).toContainText("Stage 2 をクリアしました");
  await expect(unlock).toContainText("方針 — 転院患者の対応");
  await expect(screen(page)).toHaveAttribute("data-mode", "alert");
  // ①は押しても進まない（1900ms で自動）。
  await unlock.click();
  await expect(page.getByTestId("clear-field")).toContainText("整った一覧をいただきました。");
  await expect(unlock).toHaveCount(0);
  await expect(page.getByTestId("clear-field")).toContainText("5A病棟 師長");
  await expectArt(page.getByTestId("clear-field"), "stage2-ward-5a-head-nurse-clear.webp");

  await nextButton(page).click();
  const exec = page.getByTestId("clear-exec");
  await expect(exec).toContainText("できる人がいなかったから");
  await expect(exec.locator(".who")).toHaveText("看護部長");
  await expectArt(exec, "stage2-nursing-director-clear.webp");

  await readAndNext(page);
  const handover = page.getByTestId("clear-handover");
  await expect(handover).toContainText("操作する人を交代してください");
  await expect(handover).toContainText("交代のご案内は、この先でもう一度あります。");
  expect(game.advances).toHaveLength(0);

  await page.waitForTimeout(500);
  await nextButton(page).dblclick();

  await expect(page.getByTestId("red-band")).toHaveText(stageEntryBands.s3);
  await expect(screen(page)).toHaveAttribute("data-mode", "crisis");
  await expect(handover).toHaveCount(0);
  await expect(page.getByTestId("mission-bar")).toContainText("Stage 3　方針");
  await expect(page.getByTestId("s2-work")).toHaveCount(0);
  // 赤帯は一過性：数秒で引き上げる。
  await expect(page.getByTestId("red-band")).toHaveCount(0, { timeout: 5_000 });
  expect(game.advances).toHaveLength(1);
  expect(game.advances[0]).toMatchObject({ type: "advance", from: "s2", to: "s3" });
});

test("演出の途中で再読み込みすると①からやり直し、advance はまだ送らない", async ({ page }) => {
  const game = await fakeGame(page, "s3");
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "B班");

  await expect(page.getByTestId("clear-field")).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 3 をクリアしました");
  await expect(page.getByTestId("clear-exec")).toHaveCount(0);
  expect(game.advances).toHaveLength(0);

  await expect(page.getByTestId("clear-field")).toContainText("方針を受け取りました。");
  // ②③はボタンでなくても、絵のどこを押しても進む。
  await page.getByTestId("clear-field").click({ position: { x: 200, y: 120 } });
  await expect(page.getByTestId("clear-exec")).toContainText(stageClears.s3.exec[0]);
  await expectArt(page.getByTestId("clear-exec"), "stage3-nursing-director-clear.webp");
  expect(game.advances).toHaveLength(0);
  // 交代の案内が無いステージは③を閉じたら advance。
  await page.waitForTimeout(500);
  await page.getByTestId("clear-exec").click({ position: { x: 200, y: 120 } });
  await expect(page.getByTestId("red-band")).toHaveText("原因不明の発熱、一気に14人へ。");
  await expect(page.getByTestId("clear-handover")).toHaveCount(0);
  expect(game.advances).toEqual([
    expect.objectContaining({ type: "advance", from: "s3", to: "s4" }),
  ]);
});

test("Stage 1 のクリア：結果窓→OK→①、事務長の評価が③の先頭に付き、advance で peace→alert", async ({
  page,
}) => {
  const game = await fakeGame(page, "s1");
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "C班");

  // 演出より先に Stage 1 の結果窓。OK を押したかは保存しないので、押してから再読み込みしても
  // 結果窓から出し直す（advance はまだ送らない）。
  const result = page.getByTestId("s1-clear");
  const ok = result.getByRole("button", { name: "確認した（次へ）" });
  await expect(result).toContainText("受信トレイが落ち着きました");
  await expect(page.getByTestId("clear-unlock")).toHaveCount(0);
  await ok.click();
  await expect(page.getByTestId("clear-unlock")).toBeVisible();
  await page.reload();
  await expect(result).toContainText("受信トレイが落ち着きました");
  await expect(page.getByTestId("clear-unlock")).toHaveCount(0);
  expect(game.advances).toHaveLength(0);
  await ok.click();

  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 1 をクリアしました");
  await expect(screen(page)).toHaveAttribute("data-mode", "peace");
  // レースの時計は Stage 1 の了解（サーバ時計で90秒前）から回っていて、時間とともに進む。
  // サーバの時計は10分進んでいるので、補正していなければ負（00:00）になる。
  const first = await mmssSeconds(page.getByTestId("clock"));
  expect(first).toBeGreaterThanOrEqual(90);
  expect(first).toBeLessThan(150);
  await expect
    .poll(() => mmssSeconds(page.getByTestId("clock")), { timeout: 5_000 })
    .toBeGreaterThan(first);

  await expect(page.getByTestId("clear-field")).toContainText("返信、ぜんぶ届きました。");
  await nextButton(page).click();
  const exec = page.getByTestId("clear-exec");
  await expect(exec.locator(".say").first()).toHaveText(
    "ほう。手が早いですね。……派遣の方にしては。",
  );
  await readAndNext(page);

  await expect(screen(page)).toHaveAttribute("data-mode", "alert");
  await expect(page.getByTestId("red-band")).toHaveText(
    "5A病棟より緊急連絡。MRSA疑い、拡大の可能性。",
  );
  const mission = page.getByTestId("mission-bar");
  await expect(mission).toContainText("Stage 2　火の手");
  await expect(mission).toContainText("7:00 申し送りまで");
  // Stage 2 はサーバ時計で 60 秒前に始まった：5分の締切まで残り4分弱（補正していなければ14分）。
  const left = await mmssSeconds(page.getByTestId("mission-countdown"));
  expect(left).toBeGreaterThan(200);
  expect(left).toBeLessThanOrEqual(240);
  expect(game.advances).toHaveLength(1);
});
