import { expect, test, type Page } from "@playwright/test";

import { enterTeam, passClearPopups, SERVED_MOCK } from "../served-mock-helpers";

/**
 * Stage 1 のラウンド遷移だけを通すテスト（監査レーン専用）。
 *
 * 通しテスト（full-run.spec.ts）は R1 の5通を丁寧に返し切って1ラウンドで
 * クリアする経路しか踏まない。2026-09-11 に入れた次の3つは、そこを一度も通らない
 * ——どれも外すと当日チームが詰むか、Stage 1 の山（AIに材料を渡すと速くなる、の
 * 体感）が丸ごと消える。
 *
 *  ① 前任ICNのメールへ返信しても、クリア条件が「5通」から動かないこと。
 *     動くと、親切に返事をしたチームだけが永久にクリアできなくなる。
 *  ② R2 が時間切れで失敗し、R3 へ渡ること。R2 が普通に通ると苅部さんの
 *     コンテキスト指南が出ず、Stage 1 の山が消える。
 *  ③ R3 に失敗したら同じ5通でやり直し、**やり直した回でクリアできる**こと。
 *     doneIds を消し忘れる・締切を打ち直し忘れると、やり直しの回が永久に
 *     終わらないか、1通も返さずに通ってしまう。
 *
 * 網羅は狙わない（このモックは 2026-09-26 までの使い捨て）。文言の細部や
 * 苅部さんの台詞の出し分けは、壊れても当日の進行は止まらないので見ない。
 *
 * 所要は実時間でおよそ3分。R2 の自然終了（着弾23秒＋持ち時間60秒＝83秒）を
 * 実時間で待つのが大半で、ここは縮められない——待ち時間そのものが
 * 「R2 は手を付けなければ必ず失う」という検査だからである。
 * 演出の待ちを実時間で受ける理由は full-run.spec.ts 冒頭に同じ。
 */

test.describe.configure({ mode: "serial" });

/** Stage 1 の返信。S1_MIN_LEN（70文字）以上かつ S1_POLITE の丁寧語を含むこと。 */
const POLITE_REPLY =
  "いつもお世話になっております。ご連絡いただきありがとうございます。担当にて確認のうえ、折り返しご連絡いたします。お手数をおかけいたしますが、何卒よろしくお願い申し上げます。";

/** S1_MIN_LEN に届かない返信。送れてしまうが「そっけない」判定を食らう。 */
const CURT_REPLY = "承知しました。";

/** コンテキスト欄の充足ライン（モックの S1_CTX_MIN）。 */
const CTX_MIN = 100;

/** 引き継ぎメモを除いた、そのラウンドの5通の件名。 */
const roundSubjects = async (page: Page): Promise<string[]> => {
  const subjects = await page.locator("#mails button.mail .subj").allInnerTexts();
  return subjects.slice(1).map((s) => s.trim());
};

/** 5通が出そろうまで待つ（最後の1通は着弾から23秒）。メモを含めて6行。 */
const waitForAllMails = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () => document.querySelectorAll("#mails button.mail").length >= 6,
    null,
    { timeout: 60_000 },
  );
};

/** 開いているメールの残り時間（mm:ss）を秒で読む。 */
const openMailSecondsLeft = async (page: Page): Promise<number> => {
  const label = (await page.locator("#s1-timer").innerText()).trim();
  // mm:ss だけを通す。split(":") と Number() の組み合わせだと "0:59:壊れた値" や
  // "0:59.5" も読めてしまい、表示が壊れたまま検査が通る。分は1桁以上、秒は
  // 2桁で 00〜59 に限る。
  const m = /^(\d+):([0-5]\d)$/.exec(label);
  if (!m) {
    throw new Error(`残り時間が mm:ss として読めません: ${label}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
};

/** そのラウンドの5通へ同じ本文で返信する。 */
const replyToAll = async (page: Page, body: string): Promise<void> => {
  for (const subject of await roundSubjects(page)) {
    await page
      .locator("#mails button.mail")
      .filter({ hasText: subject })
      .click({ timeout: 60_000 });
    await page.locator("#s1-body").fill(body);
    await page.getByRole("button", { name: "送信する" }).click();
  }
};

test("Stage 1：R2で詰まってもR3をやり直してクリアできる", async ({ page }) => {
  // R2の自然終了（83秒）とR3を2周する分、journeyプロジェクトの既定（300秒）では足りない。
  test.setTimeout(420_000);

  // 事務長のブリーフィングは開発用エイリアスで飛ばす（本番コードに分岐は足さない
  // ——devbar の「Stage 1（説明を飛ばす）」と同じ s1SkipBrief の経路）。Prologue から
  // ここまでの受け渡しは full-run.spec.ts が見ている。
  await page.goto(`${SERVED_MOCK}#s1-nobrief`);
  await enterTeam(page);
  await expect(page.locator(".stage-title")).toHaveText("Stage 1　平常運転", { timeout: 30_000 });

  // ── ① 前任ICNのメールへ返信しても、クリア条件は5通のまま ──────────
  const memoRow = page.locator("#mails button.mail").first();
  await memoRow.click();
  await page.locator("#s1-memo-body").fill("ありがとうございます。とても助かります。");
  await page.getByRole("button", { name: "送信する" }).click();
  await expect(memoRow).toContainText("返信済み");
  // ここが本題：メモに返信しても「返信済み N / 5」の分子は動かない。動いたら
  // doneIds へ混ざっており、5通を返してもクリアに届かない／逆に届きすぎる。
  await expect(page.locator(".s2-count")).toContainText("0 / 5");

  // ── R1：5通をそっけなく返して失敗させる ──────────────────────
  await waitForAllMails(page);
  await replyToAll(page, CURT_REPLY);
  await expect(page.locator("#s1res-main .hd2")).toHaveText("1回目、終了", { timeout: 60_000 });
  await page.getByRole("button", { name: "確認した（次へ）" }).click();
  await expect(page.locator("#ov-s1res")).toBeHidden();

  // ── ② R2：手を付けずに待つと、5通とも時間切れで失敗する ──────────
  const r2StartedAt = Date.now();
  await waitForAllMails(page);
  // 最後の1通が着弾した時点で、その1通にはまだ持ち時間がまるまる残っている
  // （＝ラウンドの終わりは「最後の着弾＋S1_LIMIT」。R2の猶予の計算の前提）。
  await expect(page.locator("#mails button.mail").last()).toContainText("00:5");
  await expect(page.locator("#s1res-main .hd2")).toHaveText("2回目、終了", { timeout: 150_000 });
  await expect(page.locator("#s1res-main .sum")).toContainText("0 / 5");
  const r2Seconds = (Date.now() - r2StartedAt) / 1000;
  // 着弾23秒＋持ち時間60秒＝83秒で自然に終わる。ここが大きくずれたら at か
  // S1_LIMIT が動いており、R2の猶予（S1_LIMIT 付近のコメント）を計算し直すこと。
  expect(
    r2Seconds,
    `R2の自然終了は83秒前後のはず（実測 ${r2Seconds.toFixed(1)}秒）`,
  ).toBeGreaterThan(70);
  expect(r2Seconds).toBeLessThan(120);
  await page.getByRole("button", { name: "確認した（次へ）" }).click();
  await expect(page.locator("#ov-s1res")).toBeHidden();

  // ── ③ R3 第1周：共有フォルダのメモをコンテキストへ貼り、短い返信で失敗させる ──
  await expect(page.locator(".stage-title")).toContainText("（3回目・コンテキストあり）");
  await waitForAllMails(page);
  const firstRoundSubjects = await roundSubjects(page);

  // 受信トレイのメモはとっくに消えている。材料は共有フォルダから取る。
  await expect(page.locator("#mails button.mail").first()).toContainText("返信済み");
  await page.locator("#btn-open-memo").click();
  await expect(page.locator("#viewer-name")).toHaveText("引き継ぎメモ_前任ICN.txt");
  const memoText = await page.locator("#sheet").innerText();
  // 貼ればコンテキストが「足りている」と判定される長さがあること（S1_CTX_MIN）。
  expect(memoText.length).toBeGreaterThanOrEqual(CTX_MIN);
  await page.locator("#btn-viewer-close").click();
  await expect(page.locator("#ov-viewer")).toBeHidden();

  await page.locator("#mails button.mail").filter({ hasText: firstRoundSubjects[0] }).click();
  await page.locator("#s1-ctx").fill(memoText);
  await replyToAll(page, CURT_REPLY);
  await expect(page.locator("#s1res-main .hd2")).toHaveText("3回目、終了", { timeout: 60_000 });
  // 「次へ」ではなく「もう一度」と分かる文言で送り出す。
  await page.getByRole("button", { name: "もう一度、受け取る" }).click();
  await expect(page.locator("#ov-s1res")).toBeHidden();

  // ── ③続き：やり直しの回 ────────────────────────────────
  await expect(page.locator(".stage-title")).toContainText("（4回目・コンテキストあり）");

  // 着弾が at = 0/5/11/17/23 で**やり直す**こと。ここが s1.t0 の打ち直しを
  // 検査している唯一の場所——打ち直さないと s1Now() が大きいままなので、次の
  // s1Frame で5通が一斉に着弾する（そのとき due は着弾時刻から数え直されるため、
  // 残り時間だけを見ても差が出ない）。まず「まだ1通目しか来ていない」を見る。
  const retryStartedAt = Date.now();
  await expect(
    page.locator("#mails button.mail"),
    "やり直し直後は引き継ぎメモ＋1通目だけ",
  ).toHaveCount(2, { timeout: 4_000 });

  // 5通そろうまでに、2通目以降の着弾ぶんの時間（最後は23秒）がかかること。
  await waitForAllMails(page);
  const landingSeconds = (Date.now() - retryStartedAt) / 1000;
  expect(
    landingSeconds,
    `やり直しの5通目は23秒かけて着弾するはず（実測 ${landingSeconds.toFixed(1)}秒）`,
  ).toBeGreaterThan(15);
  expect(landingSeconds).toBeLessThan(45);

  // 同じ5通が降り直す。
  expect(await roundSubjects(page)).toEqual(firstRoundSubjects);
  // doneIds が消えている（前回返した分が「返信済み」のまま残っていない）。
  // 残っていると、1通も返さないまま clean が成立して通過してしまう。
  await expect(page.locator(".s2-count")).toContainText("0 / 5");

  // 締切も打ち直されている。いま着弾したばかりの1通は、持ち時間（60秒）が
  // ほぼ丸ごと残っているはず——「00:」の前方一致では残り1秒でも通ってしまうので、
  // 秒数で見る。
  await page.locator("#mails button.mail").last().click();
  const secondsLeft = await openMailSecondsLeft(page);
  expect(secondsLeft, `着弾直後の残り時間は60秒近いはず（実測 ${secondsLeft}秒）`).toBeGreaterThan(
    45,
  );
  expect(secondsLeft).toBeLessThanOrEqual(60);

  // 貼ったコンテキストは残っている——やり直しのたびに消えると、やり直し自体が罰になる。
  expect((await page.locator("#s1-ctx").inputValue()).length).toBeGreaterThanOrEqual(CTX_MIN);

  // やり直した回でクリアできる（ここが通らないと当日チームが永久に抜けられない）。
  await replyToAll(page, POLITE_REPLY);
  await expect(page.locator("#s1res-main .hd2")).toHaveText("受信トレイが落ち着きました", {
    timeout: 60_000,
  });
  // クリアの回だけ事務長はこの窓に出ない（評価は次の幹部ポップアップへ寄せてある）。
  await expect(page.locator("#ov-s1res .por")).toBeHidden();
  await page.getByRole("button", { name: "確認した（次へ）" }).click();

  // クリアの3段演出を通って Stage 2 の急変へ進む。
  await passClearPopups(page, { title: "Stage 1 をクリアしました" });
  await expect(page.locator(".stage-title")).toHaveText("Stage 2　火の手", { timeout: 60_000 });
});
