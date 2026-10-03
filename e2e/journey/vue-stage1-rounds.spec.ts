import { expect, test, type Page, type Request } from "@playwright/test";

import {
  DEADLINE_GRACE_MS,
  gameViewResponseSchema,
  STAGE1_REPLY_LIMIT_MS,
  STAGE1_SCHEDULES,
  teamGameCommandSchema,
  type Stage1State,
  type TeamGameCommand,
} from "../../packages/domain/src/index.js";
import { viewerDocs } from "../../packages/content/src/index.js";
import { WORKER_ORIGIN } from "../ports";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";

/**
 * Vue 版 Stage 1 のラウンド遷移を、本物の Worker と実時間で通す（監査レーン専用。V3-4）。
 * 見るのは次の3観点——
 *
 *  ① 前任ICNのメモへ返信しても、クリア条件が「5通」から動かないこと。
 *  ② R2 が時間切れで失敗し、R3 へ渡ること（苅部さんのコンテキスト指南の前提）。
 *  ③ R3 に失敗したら同じ5通でやり直し、やり直した回でクリアできること。
 *
 * ——に、Vue 版で足した次の3つを加える。
 *
 *  ④ R2 の待機中に再読み込みしても画面が戻り、返信・締切の報告（s1.settle）・次の回への
 *     移行（s1.next-round）が二重に適用されない。サーバの状態を GET /game で読んで確かめる。
 *  ⑤ R3 の5回目の挑戦（r3Try 3）で、最初の返信の後に苅部さんのヒント（#222）のバッジが出る。
 *     4回目では出ない。
 *  ⑥ クリアの結果窓 → OK → クリアの演出を通って Stage 2 へ入る。
 *
 * page.route は使わない。サーバの時計は進められないので、R2 の自然終了（最後の着弾23秒＋
 * 持ち時間60秒＋猶予）と、4回目で1通を時間切れにする待ちを実時間で受ける。所要はおよそ4〜5分。
 * 待ちはすべて画面の状態で受け、上限は下の定数から計算する（固定の sleep はしない）。
 */

test.describe.configure({ mode: "serial" });

/** 丁寧（70文字以上、「ます」を含む）。 */
const POLITE =
  "お問い合わせいただきありがとうございます。確認のうえ、担当部署と調整して改めてご連絡いたしますので、恐れ入りますが今しばらくお待ちいただけますでしょうか。";

/** 送れるが、ラウンドの終わりに「そっけない」と数えられる返信。 */
const CURT = "承知しました。";

/** 最後の1通が着弾してから、締切と猶予を過ぎるまで（ラウンドの自然終了）。 */
const LAST_LANDING_MS = Math.max(...STAGE1_SCHEDULES[1].map((mail) => mail.at)) * 1_000;
const ROUND_TIMEOUT_MS = LAST_LANDING_MS + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS;
/** 画面の確認とコマンドの往復のぶんの余裕。 */
const SLACK_MS = 30_000;

const row = (page: Page, id: string) => page.locator(`[data-mail-id="${id}"]`);
const inboxRows = (page: Page) => page.getByTestId("inbox-list").getByRole("button");
/** メモを除いた、そのラウンドの行で「返信済み」のもの。 */
const repliedRoundRows = (page: Page) =>
  page
    .getByTestId("inbox-list")
    .locator('[data-mail-id]:not([data-mail-id="memo"])')
    .filter({ hasText: "返信済み" });
const replyBox = (page: Page) => page.getByRole("textbox", { name: "返信" });
const contextBox = (page: Page) => page.getByRole("textbox", { name: "コンテキスト" });
const sendButton = (page: Page) => page.getByRole("button", { name: "送信する" });
const missionBar = (page: Page) => page.getByTestId("mission-bar");
const result = (page: Page) => page.getByTestId("s1-result");
const badge = (page: Page) => page.getByTestId("karube-badge");
const phoneBar = (page: Page) =>
  page.getByTestId("karube-phone").getByRole("button", {
    name: /メッセージ/,
  });

/** メモと5通が出そろうまで（最後の1通は着弾から23秒）。 */
const waitForAllMails = async (page: Page): Promise<void> => {
  await expect(inboxRows(page)).toHaveCount(6, { timeout: LAST_LANDING_MS + SLACK_MS });
};

const replyTo = async (page: Page, id: string, text: string): Promise<void> => {
  await row(page, id).click();
  await replyBox(page).fill(text);
  await sendButton(page).click();
  await expect(row(page, id)).toContainText("返信済み");
};

/** 苅部さんの窓を開いて読み、閉じる。 */
const readKarube = async (page: Page, text: string): Promise<void> => {
  await phoneBar(page).click();
  await expect(page.getByTestId("karube-log")).toContainText(text, { timeout: 10_000 });
  await phoneBar(page).click();
  await expect(page.getByTestId("karube-log")).toHaveCount(0);
  await expect(badge(page)).toHaveCount(0);
};

/**
 * サーバが持っている Stage 1 の状態と、サーバの時刻（GET /game は判定しないので、読むだけで
 * 何も変わらない）。
 */
const serverStage1At = async (
  page: Page,
  code: string,
): Promise<{ s1: Stage1State; serverNow: number }> => {
  const response = await page.request.get(`/api/teams/${code}/game`, {
    headers: { Origin: WORKER_ORIGIN },
  });
  expect(response.ok()).toBe(true);
  const view = gameViewResponseSchema.parse(await response.json());
  if (view.state.s1 === null) throw new Error("Stage 1 が始まっていない");
  return { s1: view.state.s1, serverNow: view.serverNow };
};

const serverStage1 = async (page: Page, code: string): Promise<Stage1State> =>
  (await serverStage1At(page, code)).s1;

/** 画面が送ったコマンド。同じ commandId の送り直しは1回と数える（サーバが1回だけ適用する）。 */
const recordCommands = (page: Page) => {
  const sent: TeamGameCommand[] = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/game/commands")) return;
    const parsed = teamGameCommandSchema.safeParse(request.postDataJSON());
    if (parsed.success) sent.push(parsed.data);
  });
  return {
    distinct: (match: (command: TeamGameCommand) => boolean): number =>
      new Set(sent.filter(match).map((command) => command.commandId)).size,
  };
};

test("Vue 版 Stage 1：R2で詰まってもR3をやり直してクリアできる（実 Worker・実時間）", async ({
  page,
}) => {
  // R2 の自然終了と4回目の時間切れ（各85秒）に、3回分の着弾（各23秒）と演出が乗る。
  test.setTimeout(480_000);
  const code = uniqueTeamCode();
  const commands = recordCommands(page);

  // ── Prologue を画面から抜けて、Stage 1 のブリーフィングへ（e2e/prologue と同じ入り方） ──
  await page.goto("/");
  await enterTeam(page, code, "通し班");
  await page.getByRole("button", { name: "メールを開く" }).click();
  for (const id of ["p0", "p1", "p2"]) {
    await row(page, id).click();
    await replyBox(page).fill("承知しました");
    await sendButton(page).click();
    // 次の行を開く前に、返した行が「返信済み」になるのを待つ。最後の1通はクリアで Stage 1 へ
    // 移るので、下のブリーフィングがその確かめになる。
    if (id !== "p2") await expect(row(page, id)).toContainText("返信済み");
  }
  const briefing = page.getByTestId("s1-briefing");
  await expect(briefing).toBeVisible({ timeout: 15_000 });
  await briefing.click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(briefing).toHaveCount(0);

  // ── ① メモへ返信しても、5通の側の「返信済み」は増えない ──────────────
  await replyTo(page, "memo", "ありがとうございます。とても助かります。");
  await expect(repliedRoundRows(page)).toHaveCount(0);
  expect((await serverStage1(page, code)).doneIds).toEqual([]);

  // ── R1：5通をそっけなく返して失敗させる ──────────────────────────
  await waitForAllMails(page);
  for (const { id } of STAGE1_SCHEDULES[1]) await replyTo(page, id, CURT);
  await expect(result(page)).toContainText("1回目、終了", { timeout: SLACK_MS });
  await result(page).getByRole("button", { name: "確認した（次へ）" }).click();
  await expect(result(page)).toHaveCount(0);
  await expect(missionBar(page)).toContainText("2回目・AIあり");

  // ── ② R2：1通だけ返し、残りは手を付けずに待つ。④ 待機中に再読み込み ──────
  // R2 の長さはサーバの時計で測る（画面やこのテストの遅れを含めない）。
  const { roundStartedAt: r2StartedAt } = await serverStage1(page, code);
  await expect(row(page, "r1")).toBeVisible();
  await replyTo(page, "r1", POLITE);
  await waitForAllMails(page);
  await page.reload();
  // 画面が戻る：R2 のまま、返した1通は返信済み、ほかは残り時間を数えている。
  await expect(missionBar(page)).toContainText("2回目・AIあり");
  await expect(inboxRows(page)).toHaveCount(6);
  await expect(row(page, "r1")).toContainText("返信済み");
  await expect(repliedRoundRows(page)).toHaveCount(1);
  await expect(result(page)).toHaveCount(0);

  await expect(result(page)).toContainText("2回目、終了", { timeout: ROUND_TIMEOUT_MS + SLACK_MS });
  await expect(result(page)).toContainText("1 / 5 件しか返せませんでした。");
  const { s1: r2, serverNow: r2ReadAt } = await serverStage1At(page, code);
  const r2Seconds = (r2ReadAt - r2StartedAt) / 1000;
  // 着弾23秒＋持ち時間60秒＋猶予を過ぎるまで終わらない（先に終わるなら締切の計算が狂っている）。
  // サーバは締切前の s1.settle を拒むので、結果窓が出た後に読んだ時刻は必ずこれ以上になる。
  expect(
    r2Seconds,
    `R2 の自然終了（サーバ時計で ${r2Seconds.toFixed(1)}秒）`,
  ).toBeGreaterThanOrEqual(ROUND_TIMEOUT_MS / 1000);
  expect(r2Seconds).toBeLessThan((ROUND_TIMEOUT_MS + SLACK_MS) / 1000);
  expect(r2.round).toBe(2);
  expect(r2.status).toEqual({ phase: "round-result", failure: "round2" });
  expect(r2.doneIds.filter((id) => id === "r1")).toHaveLength(1);
  expect(commands.distinct((c) => c.type === "s1.reply" && c.mailId === "r1")).toBe(1);

  // 結果窓の前でもう一度読み込んでも、窓が出直すだけで次の回へは進まない。
  await page.reload();
  await expect(result(page)).toContainText("2回目、終了");
  await result(page).getByRole("button", { name: "確認した（次へ）" }).dblclick();
  await expect(result(page)).toHaveCount(0);

  // ── ③ R3 第1周（3回目）：共有フォルダのメモをコンテキストへ貼り、そっけなく返して失敗 ──
  await expect(missionBar(page)).toContainText("3回目・コンテキストあり");
  const r3 = await serverStage1(page, code);
  // 次の回への移行は1回だけ（二重なら r3Try が2になり、4回目から始まってしまう）。
  expect(r3.round).toBe(3);
  expect(r3.r3Try).toBe(1);
  expect(commands.distinct((c) => c.type === "s1.next-round")).toBe(2);

  await page
    .getByTestId("shared-folder")
    .getByRole("button", { name: viewerDocs.s1memo.name })
    .click();
  const memoText = await page.getByTestId("viewer-text").innerText();
  expect(memoText.length).toBeGreaterThan(100);
  await page.getByTestId("viewer").getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByTestId("viewer")).toHaveCount(0);

  await waitForAllMails(page);
  await row(page, "t1").click();
  await contextBox(page).fill(memoText);
  for (const { id } of STAGE1_SCHEDULES[3]) await replyTo(page, id, CURT);
  await expect(result(page)).toContainText("3回目、終了", { timeout: SLACK_MS });
  await result(page).getByRole("button", { name: "もう一度挑戦する" }).click();
  await expect(result(page)).toHaveCount(0);

  // ── ③続き：やり直しの回（4回目） ──────────────────────────────
  await expect(missionBar(page)).toContainText("4回目・コンテキストあり");
  // 着弾をやり直している：直後はメモと1通目だけ。
  await expect(inboxRows(page), "やり直し直後はメモと1通目だけ").toHaveCount(2, {
    timeout: 4_000,
  });
  await expect(repliedRoundRows(page)).toHaveCount(0);
  // 貼ったコンテキストは、やり直しをまたいで残る。
  await row(page, "t1").click();
  await expect(contextBox(page)).toHaveValue(memoText);
  // 開いた時点の苅部さん（やり直しの声）を読んでおく。以後のバッジはヒントだけを意味する。
  await expect(badge(page)).toBeVisible({ timeout: 10_000 });
  await readKarube(page, "〔苅部〕");

  // 4通だけ返し、最後に着弾する t6 を時間切れにして失敗させる（前の回の返信が残って
  // いれば、これで通ってしまう）。ヒントは4回目では出ない。
  await waitForAllMails(page);
  for (const id of ["t1", "t3", "t4", "t5"]) await replyTo(page, id, POLITE);
  await expect(badge(page)).toHaveCount(0);
  await expect(row(page, "t6")).toContainText("時間切れ", {
    timeout: STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + SLACK_MS,
  });
  await expect(result(page)).toContainText("4回目、終了", { timeout: SLACK_MS });
  await expect(result(page)).toContainText("4 / 5 件。");
  await expect(badge(page)).toHaveCount(0);
  await result(page).getByRole("button", { name: "もう一度挑戦する" }).click();
  await expect(result(page)).toHaveCount(0);

  // ── ⑤ 5回目：最初の返信の後に、苅部さんのヒントのバッジ ──────────────
  await expect(missionBar(page)).toContainText("5回目・コンテキストあり");
  await expect(badge(page)).toBeVisible({ timeout: 10_000 });
  await readKarube(page, "〔苅部〕");
  await waitForAllMails(page);
  await replyTo(page, "t1", POLITE);
  await expect(badge(page)).toBeVisible({ timeout: 10_000 });
  await readKarube(page, "AIは、渡されたことしか知りませんよ。");

  // ── ⑥ やり直した回でクリア → 結果窓 → OK → クリアの演出 → Stage 2 ──────────
  for (const id of ["t3", "t4", "t5", "t6"]) {
    await row(page, id).click();
    await replyBox(page).fill(POLITE);
    await sendButton(page).click();
  }
  const cleared = page.getByTestId("s1-clear");
  await expect(cleared).toContainText("受信トレイが落ち着きました", { timeout: SLACK_MS });
  await expect(cleared).toContainText("苅部さんに渡されたAIで、全通に返信しました。");
  await expect(page.getByTestId("clear-unlock")).toHaveCount(0);
  await cleared.getByRole("button", { name: "確認した（次へ）" }).click();
  await expect(cleared).toHaveCount(0);

  await expect(page.getByTestId("clear-unlock")).toContainText("Stage 1 をクリアしました");
  await expect(page.getByTestId("clear-field")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByTestId("clear-exec")).toBeVisible();
  // ③は開いた直後 400ms の押下を無視する。押せるようになるまで押し直す。
  await expect(async () => {
    await page.getByRole("button", { name: "次へ" }).click({ timeout: 1_000 });
    await expect(page.getByTestId("clear-exec")).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(missionBar(page)).toContainText("Stage 2　火の手", { timeout: SLACK_MS });
  const final = await serverStage1(page, code);
  expect(final.status).toEqual({ phase: "cleared", result: "ai" });
  expect(final.r3Try).toBe(3);
});
