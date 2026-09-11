import { expect, test, type Page } from "@playwright/test";

import {
  bubbleText,
  copyFromViewer,
  enterTeam,
  openFeverLinelist,
  passClearPopups,
  sendToAi,
  SERVED_MOCK,
} from "../served-mock-helpers";
import { WORKER_ORIGIN } from "../ports";

/**
 * 配信版モックの通しテスト（監査レーン専用）。
 *
 * ステージ単位のE2E（served-mock*.spec.ts）は、URLハッシュで各ステージへ
 * 直接入る。そこでは「1つ前のステージが次のステージへ何を渡しているか」が
 * 一度も通らない——発熱インジケータの推移、停留所（pos）、罠フラグ、経過時間、
 * 活動ログの積み上がりは、Prologueから続けて踏まないと壊れても気づけない。
 * この1本がその受け渡しを見る。
 *
 * 演出の待ちは実時間で受ける（prefers-reduced-motion を立てると later()/wait()
 * が0msへ潰れ、判定結果や各ステージの演出が一瞬で消えて検証できなくなる。
 * page.clock でタイマーを進める手も、WorkerへのfetchとWebSocketが同じ
 * タイマーに乗っているため採らない）。所要は実測でおよそ2分半。
 */

/** Prologue の返信。文面は判定されない（空欄だけ拒否）ので、1行で足りる。 */
const PROLOGUE_REPLY = "承知しました。よろしくお願いいたします。";

/** Stage 1 の返信。S1_MIN_LEN（70文字）以上かつ S1_POLITE の丁寧語を含むこと。 */
const S1_REPLY =
  "いつもお世話になっております。ご連絡いただきありがとうございます。担当にて確認のうえ、折り返しご連絡いたします。お手数をおかけいたしますが、何卒よろしくお願い申し上げます。";

/** Stage 1 の5通。落ちてくる順（0・5・11・17・23秒）。 */
const S1_SUBJECTS = [
  "サージカルマスクの在庫について",
  "先月の研修、出席されていますか",
  "今年度のICT委員会、日程を決めたいのですが",
  "抗菌薬使用量の集計、様式が変わりました",
  "月次の細菌検査報告書、送付先を教えてください",
] as const;

/** Stage 3 の3欄。罠語（殺虫剤・個室・継続）は正解語と対で書けば踏まない。 */
const S3_ANSWERS = {
  "#s3-ppe": "3名はいずれも通常疥癬のため、個室隔離は不要です。標準予防策で対応します。",
  "#s3-release":
    "イベルメクチン内服による治療が完了し、最終投与から24時間が経過した時点で、追加していた予防策は解除し標準予防策のみに戻します。",
  "#s3-clean": "リネン・寝具は通常の洗濯で問題ありません。殺虫剤の散布や熱処理は不要です。",
} as const;

const S4_SUMMARY =
  "東陵国で原因不明の発熱19例。うち15例で発熱の8〜18時間前に眼痛（眼の奥の鈍い痛み）を認め、11例で羞明がみられた。既知病原体の検査はすべて陰性。";
const S4_ACTION = "夜勤スタッフを含む職員に対し、眼痛や羞明がないかを問診で確認します。";

/** 活動ログのPOST本文から kind を1つ取り出す。読めない本文は黙って捨てる。 */
const activityKindOf = (body: string | null): string | null => {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) return null;
    const { kind } = parsed as { kind: unknown };
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** ネストしたオブジェクトを1段だけ、形を確かめながら降りる。 */
const nestedObject = (value: unknown, key: string): Record<string, unknown> => {
  const shapeError = new Error("チェックポイントの応答が想定の形ではありません。");
  if (!isRecord(value)) throw shapeError;
  const nested = value[key];
  if (!isRecord(nested)) throw shapeError;
  return nested;
};

/**
 * サーバに残ったチェックポイント。ステージ境界の受け渡しは、画面だけでなく
 * サーバ側にも同じものが届いていて初めて成立する（当日は再読み込みからの
 * 復帰がここに乗る）。同一オリジンのfetchで取る——Originガードを通すため。
 */
const fetchCheckpoint = async (page: Page, teamCode: string): Promise<Record<string, unknown>> => {
  const raw: unknown = await page.evaluate(async (code: string) => {
    const response = await fetch(`/api/teams/${code}/checkpoint`);
    return response.json() as Promise<unknown>;
  }, teamCode);
  return nestedObject(nestedObject(raw, "checkpoint"), "body");
};

const clearPrologue = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "メールを開く" }).click();
  const mails = page.locator("#mails button.mail");
  await expect(mails).toHaveCount(3);
  // 3通とも返信欄が出る。文面は判定されない（空欄だけ拒否）ので、同じ本文でよい。
  // 一覧の並びは返信しても変わらない（MAILS の添字順）ので、nth で順に押せる。
  for (let index = 0; index < 3; index += 1) {
    await mails.nth(index).click();
    await page.locator("#inbox-body").fill(PROLOGUE_REPLY);
    await page.getByRole("button", { name: "送信する" }).click();
  }
  // 3通とも片付くと、演出を挟まずStage 1のブリーフィングが開く（inboxFrame）。
  await expect(page.locator("#ov-brief")).toBeVisible({ timeout: 20_000 });
};

const clearStage1 = async (page: Page): Promise<void> => {
  // 段落は BRIEF_BEATS（最後は5.3秒）で1つずつ出る。参加者と同じく、
  // 本文をクリックして早送りしてから［了解しました］を押す。
  await page.locator("#ov-brief .tb").click();
  // 交代の案内（#ov-handover）が2回入ることは、ここで先に予告してある
  // （Issue #148）。どのステージで来るかは明かさない。
  await expect(page.locator("#ov-brief")).toContainText(
    "操作する担当は、途中で2回交代していただきます",
  );
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(page.locator("#ov-brief")).toBeHidden();
  // 経過時間の帯はここで動き出す（s1Begin → startClock）。
  await expect(page.locator("#clock")).not.toHaveClass(/idle/);

  for (const subject of S1_SUBJECTS) {
    // 最後の1通は入場23秒後に届く。#mails は250msごとに描き直されるので
    // locatorで待つ（elementHandleを持ち回らない）。
    await page
      .locator("#mails button.mail")
      .filter({ hasText: subject })
      .click({ timeout: 60_000 });
    await page.locator("#s1-body").fill(S1_REPLY);
    await page.getByRole("button", { name: "送信する" }).click();
  }

  // 5通とも丁寧に返し切ると1ラウンドで完了する（s1RoundComplete → clean）。
  await expect(page.locator("#ov-s1res")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#s1res-main")).toContainText("受信トレイが落ち着きました");
  await page.getByRole("button", { name: "確認した（次へ）" }).click();
  // 結果ウィンドウを閉じると、他ステージと同じクリアの3段演出が続く。
  // Stage 1 だけ副題（次ステージ名）を持たない——この直後の赤帯が「火の手」の
  // 一報そのものなので、先に名前を出すと一報が死ぬ。
  await passClearPopups(page, { title: "Stage 1 をクリアしました" });
};

const clearStage2 = async (page: Page): Promise<void> => {
  await expect(page.locator(".stage-title")).toHaveText("Stage 2　火の手", { timeout: 30_000 });
  // AIパネルは苅部さんのPHS（S2_KARUBE_DELAY＝45秒）で初めて開く。
  await expect(page.locator("#phs-badge")).toBeVisible({ timeout: 90_000 });
  await page.locator("#phs-bar").click();
  await expect(page.locator("#pane-r")).not.toHaveClass(/collapsed/, { timeout: 20_000 });
  // PHSの窓は開きっぱなしだと提出ボタンに重なる。読み終えたら畳む（同じつまみ）。
  await page.locator("#phs-bar").click();
  await expect(page.locator("#phs-win")).toBeHidden();

  await sendToAi(page, "この表の書き方を統一して、タブ区切りで出してください。");
  // Stage 2 はLIVEでも常に台本応答（s2ScriptedTable）。
  const toGrid = page.locator("#ai-log .bubble.scripted .to-grid");
  await expect(toGrid).toBeVisible({ timeout: 20_000 });
  await toGrid.click();
  await expect(page.locator("#recog")).toHaveText("20行 × 6列");

  await page.getByRole("button", { name: "提出する" }).click();
  await expect(page.locator("#verdict")).toContainText("Stage 2 をクリアしました", {
    timeout: 20_000,
  });
  // Stage 2 のクリア後だけ、④操作担当の交代の案内が続く（1回目。Issue #148）。
  await passClearPopups(page, {
    title: "Stage 2 をクリアしました",
    sub: "方針 — 転院患者の対応",
    handover: true,
  });
};

const clearStage3 = async (page: Page): Promise<void> => {
  await expect(page.locator(".stage-title")).toHaveText("Stage 3　方針", { timeout: 30_000 });
  await expect(page.locator("#fever")).toHaveText("9");
  await page.locator("#btn-s3notice-close").click({ timeout: 20_000 });
  await expect(page.locator("#ov-s3notice")).toBeHidden();

  // 正解経路はアプリ内のマニュアルビューアで正典を自力照合すること。
  // 隣に並ぶ「疥癬対応早見表.pdf」は汚染教材なので開かない。
  await page.locator("#btn-open-manual").click();
  await expect(page.locator("#viewer-name")).toHaveText("院内感染対策マニュアル.pdf");
  await expect(page.locator("#sheet")).toContainText("通常疥癬");
  await page.locator("#btn-viewer-close").click();
  await expect(page.locator("#ov-viewer")).toBeHidden();

  for (const [selector, answer] of Object.entries(S3_ANSWERS)) {
    await page.locator(selector).fill(answer);
  }
  await page.locator("#btn-s3-submit").click();
  await expect(page.locator("#s3-verdict")).toContainText("Stage 3 をクリアしました", {
    timeout: 20_000,
  });
  // 罠を踏むと暗転して発熱が12へ跳ねる。踏んでいないことを画面でも見る。
  await expect(page.locator("#ov-blackout")).toBeHidden();
  // 罠を踏んでいないので、現場の反応に振り返りの促し（.reflect）は付かない。
  await expect(page.locator("#ov-field")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#ov-field .reflect")).toHaveCount(0);
  await passClearPopups(page, {
    title: "Stage 3 をクリアしました",
    sub: "新情報の解釈 — 海外速報",
  });
};

const clearStage4 = async (page: Page): Promise<void> => {
  await expect(page.locator(".stage-title")).toHaveText("Stage 4　新情報の解釈", {
    timeout: 30_000,
  });
  // 赤帯と同時に発熱が9→14へ跳ねる。この14が Stage 5 の一覧の内訳そのもの。
  await expect(page.locator("#fever")).toHaveText("14", { timeout: 20_000 });

  const close = page.locator("#btn-s4director-close");
  await expect(close).toBeVisible({ timeout: 20_000 });
  // 2画面。描き直した直後の押下は連打対策（400ms）で捨てられるので押し直す。
  await expect(async () => {
    await close.click();
    await expect(page.locator("#ov-s4-director")).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  await page.locator("#s4-mail").click();
  await expect(page.locator("#ov-s4-report")).toContainText("deep ocular pain");
  await page.locator("#btn-s4-report-close").click();

  await page.locator("#s4-summary").fill(S4_SUMMARY);
  await page.getByRole("button", { name: "院長へ報告" }).click();
  await expect(page.locator("#s4-verdict")).toContainText("院長へ送信しました。", {
    timeout: 20_000,
  });

  await expect(page.locator("#s4-talk")).toBeVisible({ timeout: 20_000 });
  await page.locator("#s4-action").fill(S4_ACTION);
  await page.getByRole("button", { name: "送信する" }).click();
  // 2回目にして最後の交代の案内（Issue #148）。以降のステージでは出ない。
  await passClearPopups(page, {
    title: "Stage 4 をクリアしました",
    sub: "報告 — 保健所への発熱患者一覧",
    handover: true,
  });
};

const clearStage5 = async (page: Page): Promise<void> => {
  await expect(page.locator(".stage-title")).toHaveText("Stage 5　報告", { timeout: 30_000 });
  // Stage 4 で跳ねた14は、Stage 5 の一覧の人数と一致していなければならない。
  await expect(page.locator("#fever")).toHaveText("14");

  await openFeverLinelist(page);
  await page.locator("#viewer-col-picks label", { hasText: "氏名" }).locator("input").uncheck();
  const linelist = await copyFromViewer(page, "#btn-copy-cols");
  expect(linelist.trim().split("\n").length - 1).toBe(14); // 見出し行を除く

  await sendToAi(page, `${linelist}\n\n上の一覧を保健所提出用に整形してください。`);
  const reply = page.locator("#ai-log .bubble").filter({ hasText: "承知しました" }).last();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply.locator(".tag")).toHaveCount(0);

  await page.locator("#s5-reply").fill(await bubbleText(reply));
  await page.getByRole("button", { name: "保健所へ提出" }).click();
  await expect(page.locator("#s5-verdict")).toContainText("Stage 5 をクリアしました", {
    timeout: 20_000,
  });
  await passClearPopups(page, {
    title: "Stage 5 をクリアしました",
    sub: "掲示 — 面会制限のお知らせ",
  });
};

const clearStage6 = async (page: Page): Promise<void> => {
  await expect(page.locator(".stage-title")).toHaveText("Stage 6　掲示", { timeout: 30_000 });
  await page.locator("#btn-s6jimu-task-close").click({ timeout: 20_000 });

  await sendToAi(
    page,
    "ピクトグラム中心の掲示にしてください。マスクを着けてもらうこと、面会時間が14時から16時までであることが、一目で伝わるようにしてください。",
  );
  const picked = page.locator("#ai-log .s6-pick");
  await expect(picked).toBeVisible({ timeout: 30_000 });
  await picked.click();
  await page.getByRole("button", { name: "提出する" }).click();
  await expect(page.locator("#s6-verdict")).toContainText("Stage 6 をクリアしました", {
    timeout: 20_000,
  });
  await passClearPopups(page, {
    title: "Stage 6 をクリアしました",
    sub: "全ステージ完了 — このあとゴールです",
  });
};

const finishFinal = async (page: Page): Promise<void> => {
  await expect(page.locator("#ov-goal")).toBeVisible({ timeout: 20_000 });
  await page.locator("#goal-next").click();
  await expect(page.locator("#ov-epilogue")).toBeVisible();
  await expect(async () => {
    await page.locator("#btn-epilogue-next").click();
    await expect(page.locator("#ov-epilogue")).toBeHidden({ timeout: 1_000 });
  }).toPass();

  await expect(page.locator(".stage-title")).toHaveText("Final　振り返り");
  // エピローグで収束を告げた直後なので、発熱は0・平常表示へ戻る。
  await expect(page.locator("#fever")).toHaveText("0");

  const input = page.locator("#f-line-input");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill("AIに渡す前に、名前を消す。");
  await page.getByRole("button", { name: "記す" }).click();

  await expect(page.locator("#ov-f-relay")).toBeVisible({ timeout: 20_000 });
  for (const name of ["院長", "看護部長"]) {
    await expect(page.locator("#f-relay-cap")).toHaveText(name);
    await page.locator("#btn-f-relay-next").click();
  }
  await expect(page.locator("#f-relay-cap")).toHaveText("事務長");
  await page.locator("#btn-f-relay-next").click();

  await expect(page.locator("#ov-f-handover")).toBeVisible();
  await expect(page.locator("#hdoc-to")).toHaveText("E2E班　御中");
};

test.beforeEach(async ({ context }) => {
  // Stage 5 の添付ビューアのコピーは navigator.clipboard を使う。
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: WORKER_ORIGIN,
  });
});

test("Prologueから感謝状まで、参加者の操作だけで通しで進む", async ({ page }) => {
  const activityKinds: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/activity")) return;
    const kind = activityKindOf(request.postData());
    if (kind !== null) activityKinds.push(kind);
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto(SERVED_MOCK);
  const teamCode = await enterTeam(page);
  // 入室直後は平常。発熱の3から14への道のりが、この研修の通奏低音そのもの。
  await expect(page.locator("#fever")).toHaveText("3");
  await expect(page.locator("#clock")).toHaveClass(/idle/);

  await clearPrologue(page);
  await clearStage1(page);
  await clearStage2(page);
  await clearStage3(page);
  await clearStage4(page);
  await clearStage5(page);
  await clearStage6(page);
  await finishFinal(page);

  // 経過時間はStage 1のブリーフィングを閉じた時点から動き、止まらない。
  await expect(page.locator("#clock")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator("#clock")).not.toHaveClass(/idle/);

  // 活動ログ：各ステージの提出と判定が、通しで1本ずつ積まれている。
  // 罠を踏んでいないので trap.* は1件も無い。
  for (const kind of [
    "submit.s1-reply",
    "verdict.s1",
    "submit.s2-grid",
    "verdict.s2",
    "submit.s3",
    "verdict.s3",
    "submit.s4",
    "verdict.s4",
    "submit.s5",
    "verdict.s5",
    "submit.s6-prompt",
    "select.s6",
    "submit.final",
  ]) {
    expect(activityKinds, `活動ログに ${kind} が積まれていない`).toContain(kind);
  }
  expect(activityKinds.filter((kind) => kind.startsWith("trap."))).toEqual([]);
  expect(activityKinds.filter((kind) => kind === "submit.s1-reply")).toHaveLength(
    S1_SUBJECTS.length,
  );

  // サーバ側にも同じ到達点が残っている（当日の再読み込み復帰はここに乗る）。
  const checkpoint = await fetchCheckpoint(page, teamCode);
  expect(checkpoint.view).toBe("final");
  expect(checkpoint.pos).toBe(7);
  expect(checkpoint.trap).toEqual({ s3Used: false, s5Used: false });
  expect(checkpoint.data).toEqual({
    s3Penalty: "none",
    s5Penalty: "none",
    s4Summary: "submitted",
  });
  expect(Number(checkpoint.elapsedMs)).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
