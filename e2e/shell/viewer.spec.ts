import { expect, test, type Page } from "@playwright/test";

import {
  stage3ManualText,
  stage5FeverTable,
  viewerDocs,
  type ViewerId,
} from "../../packages/content/src/index.js";
import { gameViewResponseSchema, type GameStageId } from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "./game-view";
import { enterTeam, uniqueTeamCode } from "./helpers";

/** Stage 3 の共有フォルダの2つ: 汚染教材（早見表）と正典（マニュアル）。 */
const { s3contaminated: CONTAMINATED, s3manual: MANUAL } = viewerDocs;

/** マニュアルの章の見出し行（表題と空行の次の3行目）。 */
const [, , MANUAL_CHAPTER = ""] = stage3ManualText.split("\n");

/*
 * 共有フォルダと添付ビューア。ステージの中身はまだ無い（V3 以降）ので、`GET /api/teams/:code/game`
 * を schema に通した固定の状態で差し替え、そのステージにいるチームとして入室する。入室と疎通確認は
 * 本物の Worker。クリップボードは権限を与えて、書かれた中身を読み戻す。
 */

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

const enterAt = async (page: Page, stage: GameStageId): Promise<void> => {
  const base = serverNow();
  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({
      json: gameViewResponseSchema.parse({
        ...gameView(stage, false, base),
        serverNow: serverNow(),
      }),
    });
  });
  // 登録済みのステージは自分で締切を報告する（Stage 1 の s1.settle）。本物の Worker に届くと、
  // その応答の状態（まだ Prologue のチーム）で固定の状態が上書きされるので、届かせない。
  await page.route("**/api/teams/*/game/commands", (route) => route.abort());
  const code = uniqueTeamCode();
  // Stage 3's notice from the nursing director has been read: it would cover the folder.
  await page.addInitScript((key) => {
    sessionStorage.setItem(key, "true");
  }, `hellVueS3Notice:${code}`);
  // Stage 5's deadline is long past in the fixed state: its call has been closed for this stay
  // (it would cover the viewer).
  const s5Entered = gameView(stage, false, base).state.enteredAt.s5;
  if (s5Entered !== undefined) {
    await page.addInitScript(
      ([key, value]) => {
        sessionStorage.setItem(key, value);
      },
      [`hellVueS5Call:${code}`, JSON.stringify(s5Entered)] as const,
    );
  }
  await page.goto("/");
  await enterTeam(page, code, "ビューア班");
  await expect(page.getByTestId("mission-bar")).toBeVisible();
};

const folder = (page: Page) => page.getByTestId("shared-folder");
const viewer = (page: Page) => page.getByTestId("viewer");
const readClipboard = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());

/**
 * Opens a document the way a mail attachment will (`viewer.open(id)`), for documents the shared
 * folder does not hold. No mail opens attachments yet (V3〜V8), so this reaches the viewer App.vue
 * provides through Vue's root vnode. Test-only; replace it with a click on the mail once the
 * attachment is wired.
 */
const openByAttachment = async (page: Page, id: ViewerId): Promise<void> => {
  await page.evaluate((viewerId) => {
    const field = (value: unknown, key: string | symbol): unknown =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
    const provides = field(
      field(field(document.querySelector("#root"), "_vnode"), "component"),
      "provides",
    );
    if (typeof provides !== "object" || provides === null) throw new Error("no root component");
    const key = Object.getOwnPropertySymbols(provides).find((s) => s.description === "viewer");
    const open = key === undefined ? undefined : field(Reflect.get(provides, key), "open");
    if (typeof open !== "function") throw new Error("no viewer provided");
    Reflect.apply(open, undefined, [viewerId]);
  }, id);
  await expect(viewer(page)).toBeVisible();
};

test("Stage 3：早見表がマニュアルより上。マニュアルは第5章の全文を開いてコピーでき、閉じられる", async ({
  page,
}) => {
  await enterAt(page, "s3");

  await expect(folder(page).getByRole("button")).toHaveText([
    `📄 ${CONTAMINATED.name}`,
    `📄 ${MANUAL.name}`,
  ]);
  await expect(folder(page)).not.toContainText("（何もありません）");

  await folder(page)
    .getByRole("button", { name: `📄 ${MANUAL.name}` })
    .click();
  await expect(page.getByTestId("viewer-name")).toHaveText(MANUAL.name);
  const text = page.getByTestId("viewer-text");
  expect(MANUAL_CHAPTER).toMatch(/^第5章\u3000/u);
  await expect(text).toContainText(MANUAL_CHAPTER);
  await expect(text).toContainText("５-４　予防策の解除基準（当院基準）");
  // 表ではないので列選択は出ない。
  await expect(page.getByTestId("viewer-cols")).toHaveCount(0);

  const copy = viewer(page).getByRole("button", { name: "コピー", exact: true });
  await copy.click();
  await expect(viewer(page).getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(await readClipboard(page)).toBe(stage3ManualText);
  // 1400ms で元に戻る。
  await expect(copy).toBeVisible({ timeout: 3_000 });

  await viewer(page).getByRole("button", { name: "閉じる" }).click();
  await expect(viewer(page)).toHaveCount(0);

  // 早見表（汚染教材）も同じビューアで開く。
  await folder(page)
    .getByRole("button", { name: `📄 ${CONTAMINATED.name}` })
    .click();
  await expect(page.getByTestId("viewer-name")).toHaveText(CONTAMINATED.name);
  const [contaminatedTitle = ""] = CONTAMINATED.text.split("\n");
  expect(contaminatedTitle).not.toBe("");
  await expect(page.getByTestId("viewer-text")).toContainText(contaminatedTitle);
  await viewer(page).getByRole("button", { name: "閉じる" }).click();
  await expect(viewer(page)).toHaveCount(0);
});

test("Stage 5：発熱患者一覧の列選択コピー（開くたびに全列ON、0列は警告）", async ({ page }) => {
  await enterAt(page, "s5");
  // Stage 4 以降の共有フォルダは空。資料は添付から開く。
  await expect(folder(page).getByRole("button")).toHaveCount(0);
  await expect(folder(page)).toContainText("（何もありません）");

  await openByAttachment(page, "s5list");
  const cols = page.getByTestId("viewer-cols");
  const boxes = cols.getByRole("checkbox");
  await expect(boxes).toHaveCount(stage5FeverTable.header.length);
  for (const box of await boxes.all()) await expect(box).toBeChecked();

  // 氏名を外してコピーすると、見出し行つきの TSV から氏名だけが抜ける。
  await cols.getByRole("checkbox", { name: "氏名" }).uncheck();
  await cols.getByRole("button", { name: "選んだ列をコピー" }).click();
  await expect(cols.getByRole("button", { name: "コピーしました" })).toBeVisible();
  const picked = await readClipboard(page);
  const lines = picked.split("\n");
  expect(lines[0]).toBe(stage5FeverTable.header.filter((h) => h !== "氏名").join("\t"));
  expect(lines).toHaveLength(stage5FeverTable.rows.length + 1);
  for (const row of stage5FeverTable.rows) expect(picked).not.toContain(row[1]);

  // 0列なら何もコピーせず、理由を出す。
  for (const box of await boxes.all()) await box.uncheck();
  await cols.getByRole("button", { name: "選んだ列をコピー" }).click();
  await expect(cols.getByRole("button", { name: "列を1つ以上選んでください" })).toBeVisible();
  expect(await readClipboard(page)).toBe(picked);
  await expect(cols.getByRole("button", { name: "選んだ列をコピー" })).toBeVisible({
    timeout: 3_000,
  });

  // 閉じて開き直すと全列ONに戻る。［コピー］は全文（罠はそのまま生きている）。
  await viewer(page).getByRole("button", { name: "閉じる" }).click();
  await expect(viewer(page)).toHaveCount(0);
  await openByAttachment(page, "s5list");
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  await viewer(page).getByRole("button", { name: "コピー", exact: true }).click();
  expect(await readClipboard(page)).toBe(viewerDocs.s5list.text);
  await viewer(page).getByRole("button", { name: "閉じる" }).click();
  await expect(viewer(page)).toHaveCount(0);
});

test("去年の掲示物（s6notice）には［コピー］が無い", async ({ page }) => {
  await enterAt(page, "s6");
  // Stage 6 is registered: 事務長's call covers the screen first, and 近藤さん's mail opens it.
  await page.getByTestId("s6-task").getByRole("button", { name: "了解しました" }).click();
  await page.getByRole("button", { name: /面会制限、外国人のご家族からも問い合わせが/ }).click();
  await expect(page.getByTestId("viewer-name")).toHaveText(viewerDocs.s6notice.name);
  await expect(viewer(page).getByRole("button", { name: "閉じる" })).toBeVisible();
  await expect(viewer(page).getByRole("button", { name: /コピー/ })).toHaveCount(0);
});

test("Stage 1：共有フォルダは引き継ぎメモだけ。早見表とマニュアルは出ない", async ({ page }) => {
  await enterAt(page, "s1");
  await expect(folder(page).getByRole("button")).toHaveText([`📄 ${viewerDocs.s1memo.name}`]);
  await expect(folder(page)).not.toContainText(CONTAMINATED.name);
  await expect(folder(page)).not.toContainText(MANUAL.name);

  await folder(page)
    .getByRole("button", { name: `📄 ${viewerDocs.s1memo.name}` })
    .click();
  await expect(page.getByTestId("viewer-name")).toHaveText(viewerDocs.s1memo.name);
  await viewer(page).getByRole("button", { name: "コピー", exact: true }).click();
  expect(await readClipboard(page)).toBe(viewerDocs.s1memo.text);
});
