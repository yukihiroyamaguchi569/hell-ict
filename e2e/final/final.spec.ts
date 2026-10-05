import { expect, test, type Page } from "@playwright/test";

import {
  epilogueLines,
  finalBoardTiles,
  finalCloseLines,
  finalJimuMail,
  finalKohoMail,
  finalRelay,
} from "../../packages/content/src/index.js";
import { gameViewResponseSchema } from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";
import { enterTeam, uniqueTeamCode, welcomeHeading } from "../shell/helpers";

/*
 * Final（振り返り）。ゴール → エピローグ → ボード → 一言 → リレー → 感謝状 → ［最初に戻る］。
 * Final に入ったチームを `GET /game` の固定応答で出す（S6 からの接続は V9 の通し E2E）。
 * ゲームのコマンドは1つも送らない。一言は活動ログ（POST .../activity）へ1回だけ送る。
 * 入室（/api/session）と疎通確認は本物の Worker。
 */

interface FakeFinal {
  /** Every game command the screen posted: Final must post none. */
  readonly commands: unknown[];
  /** The bodies of `POST /api/teams/:code/activity`. */
  readonly activity: Record<string, unknown>[];
}

const serveFinal = async (page: Page): Promise<FakeFinal> => {
  const base = serverNow();
  const fake: FakeFinal = { commands: [], activity: [] };
  await page.route("**/api/teams/*/game", async (route) => {
    const shown = gameView("final", false, base);
    const enteredAt = { ...shown.state.enteredAt, final: new Date(base - 60_000).toISOString() };
    await route.fulfill({
      json: gameViewResponseSchema.parse({
        ...shown,
        state: { ...shown.state, enteredAt },
        serverNow: serverNow(),
      }),
    });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    fake.commands.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, json: { message: "送ってはいけない" } });
  });
  await page.route("**/api/teams/*/activity", async (route) => {
    const body: unknown = route.request().postDataJSON();
    fake.activity.push(typeof body === "object" && body !== null ? { ...body } : {});
    await route.fulfill({ json: { ok: true } });
  });
  return fake;
};

/** The full-width space between the name and 「ゴール」 or 「御中」. */
const WIDE = "\u3000";
const TEAM = "F<b>班</b>";
const LINE = "<b>AIに渡す前に、名前を消す。</b>";

const goal = (page: Page) => page.getByTestId("final-goal");
const epilogue = (page: Page) => page.getByTestId("final-epilogue");
const relay = (page: Page) => page.getByTestId("final-relay");
const handover = (page: Page) => page.getByTestId("final-handover");
const lineBox = (page: Page) => page.getByRole("textbox", { name: "引き継ぎ" });

/** Past the goal and the epilogue, which ignores presses for 400 ms after it opens. */
const readIntro = async (page: Page): Promise<void> => {
  await goal(page).getByRole("button", { name: "振り返りへ進む" }).click();
  await expect(epilogue(page)).toContainText(epilogueLines[0]);
  await page.waitForTimeout(500);
  await epilogue(page).getByRole("button", { name: "振り返りへ" }).click();
  await expect(epilogue(page)).toHaveCount(0);
};

test("ゴールから感謝状まで。一言は1回だけ記録し、コマンドは送らず、戻っても記録は残る", async ({
  page,
}) => {
  const fake = await serveFinal(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), TEAM);

  await expect(goal(page)).toContainText(`${TEAM}${WIDE}ゴール`);
  await expect(page.getByTestId("mission-bar")).toContainText("Final");
  // The epilogue opens where the goal's button was: a second press at once does not skip it.
  await goal(page).getByRole("button", { name: "振り返りへ進む" }).click();
  await epilogue(page).getByRole("button", { name: "振り返りへ" }).click();
  await expect(epilogue(page)).toBeVisible();
  await page.waitForTimeout(500);
  await epilogue(page).getByRole("button", { name: "振り返りへ" }).click();

  const tiles = page.getByTestId("final-tile");
  await expect(tiles).toHaveCount(finalBoardTiles.length);
  await expect(tiles.last()).toHaveClass(/\blit\b/);
  // Both mails open in the shared viewer, each with its own text.
  const viewer = page.getByTestId("viewer");
  await page.getByRole("button", { name: /記者会見、終わりました/ }).click();
  await expect(page.getByTestId("viewer-name")).toHaveText(finalJimuMail.subj);
  await expect(page.getByTestId("viewer-text")).toContainText(finalJimuMail.body[1]);
  await viewer.getByRole("button", { name: "閉じる" }).click();
  await expect(viewer).toHaveCount(0);
  await page.getByRole("button", { name: /追加質問が12件/ }).click();
  await expect(page.getByTestId("viewer-name")).toHaveText(finalKohoMail.attach);
  await expect(page.getByTestId("viewer-text")).toContainText("【記者クラブ事前質問】");
  await viewer.getByRole("button", { name: "閉じる" }).click();
  await expect(viewer).toHaveCount(0);

  await page.getByRole("button", { name: "記す" }).click();
  await expect(page.getByTestId("final-piece")).toContainText("一言を入力してください。");
  expect(fake.activity).toEqual([]);

  await lineBox(page).fill(LINE);
  // The Enter that confirms an IME conversion (keyCode 229) does not write the line.
  await lineBox(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(lineBox(page)).toBeVisible();
  expect(fake.activity).toEqual([]);
  await lineBox(page).press("Enter");
  await expect(page.getByTestId("final-close")).toContainText(finalCloseLines[0]);
  await expect(page.getByTestId("final-piece")).toContainText(LINE);

  // The relay: the backdrop hurries on, but only the last voice's button leads to the certificate.
  await expect(relay(page)).toContainText(finalRelay[0].lines[0]);
  await relay(page).click({ position: { x: 8, y: 8 } });
  await expect(relay(page)).toContainText(finalRelay[1].lines[0]);
  await relay(page).click({ position: { x: 8, y: 8 } });
  await expect(relay(page)).toContainText(finalRelay[2].lines[1]);
  await relay(page).click({ position: { x: 8, y: 8 } });
  await expect(relay(page)).toContainText(finalRelay[2].lines[1]);
  await relay(page).getByRole("button", { name: "感謝状を受け取る" }).click();

  await expect(page.getByTestId("final-address")).toHaveText(`${TEAM}${WIDE}御中`);
  await expect(page.getByTestId("final-quote")).toHaveText(`「${LINE}」`);
  await expect(handover(page).locator("b", { hasText: "班" })).toHaveCount(0);
  await expect(handover(page).locator("b", { hasText: "名前を消す" })).toHaveCount(0);

  // A reload comes straight back to the certificate, once the real Worker has restored the
  // session and the game has been fetched (the mission bar shows Final again).
  await page.reload();
  await expect(page.getByTestId("mission-bar")).toContainText("Final", { timeout: 15_000 });
  await expect(page.getByTestId("final-quote")).toHaveText(`「${LINE}」`);
  await expect(goal(page)).toHaveCount(0);

  // ［最初に戻る］ keeps the record: the welcome screen, then the certificate again.
  await handover(page).getByRole("button", { name: "最初に戻る" }).click();
  await expect(handover(page)).toHaveCount(0);
  await expect(welcomeHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "メールを開く" }).click();
  await expect(page.getByTestId("final-quote")).toHaveText(`「${LINE}」`);

  expect(fake.activity).toHaveLength(1);
  expect(fake.activity[0]).toMatchObject({ kind: "submit.final", view: "final", text: LINE });
  expect(fake.commands).toEqual([]);
});

test("ゴールとエピローグは［振り返りへ］を押すまで出し直し、押した後はボードから", async ({
  page,
}) => {
  const fake = await serveFinal(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), "F班");

  await goal(page).getByRole("button", { name: "振り返りへ進む" }).click();
  await expect(epilogue(page)).toBeVisible();
  await page.reload();
  await expect(goal(page)).toContainText(`F班${WIDE}ゴール`);

  await readIntro(page);
  await page.reload();
  await expect(page.getByTestId("final-tile")).toHaveCount(finalBoardTiles.length);
  await expect(lineBox(page)).toBeVisible();
  await expect(goal(page)).toHaveCount(0);
  await expect(epilogue(page)).toHaveCount(0);

  expect(fake.activity).toEqual([]);
  expect(fake.commands).toEqual([]);
});

test("ゴールは舞台の絵の上に見出しと紙吹雪。紙吹雪は消えてクリックを妨げない", async ({ page }) => {
  const fake = await serveFinal(page);
  await page.goto("/");
  await enterTeam(page, uniqueTeamCode(), TEAM);

  const confetti = goal(page).getByTestId("final-confetti");
  await expect(confetti.locator("i")).toHaveCount(64);
  await expect(confetti).toHaveCSS("pointer-events", "none");
  // Frozen mid-fall, no piece ever ends its animation: the burst must go all the same.
  await page.addStyleTag({
    content: "[data-testid='final-confetti'] i { animation-play-state: paused !important; }",
  });

  // The stage picture is served and drawn behind the title.
  const art = goal(page).locator("img.art");
  await expect(art).toHaveAttribute("src", "/assets/images/production/final-goal-ceremony.webp");
  await expect.poll(() => art.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1672);

  // Taken away 3.4 s after the goal comes up, whether the animation ended or not.
  await expect(confetti).toHaveCount(0, { timeout: 6_000 });
  await expect(goal(page)).toContainText(`${TEAM}${WIDE}ゴール`);

  // The goal comes back on a reload, confetti and all; its button is on top of the confetti,
  // so the press lands while the pieces are still falling.
  await page.reload();
  const next = goal(page).getByRole("button", { name: "振り返りへ進む" });
  await expect(next).toBeEnabled();
  await expect(confetti.locator("i")).toHaveCount(64);
  const hit = await next.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const pieces = document.querySelectorAll("[data-testid='final-confetti'] i").length;
    return { onButton: top !== null && button.contains(top), pieces };
  });
  expect(hit).toEqual({ onButton: true, pieces: 64 });
  await next.click();
  await expect(epilogue(page)).toBeVisible();
  expect(fake.commands).toEqual([]);
});
