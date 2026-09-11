import { expect, test, type Page } from "@playwright/test";

import { enterTeam, SERVED_MOCK } from "./served-mock-helpers";

/**
 * 操作担当の交代を促す案内（#ov-handover。Issue #148）のE2E。
 *
 * チームは3人1組でPCは1台。全員が一度は操作するのに要る交代は2回なので、
 * 案内が出るのは Stage 2 と Stage 4 のクリア後だけで、クリア演出の最後
 * （①告知→②現場→③幹部→④交代）に1枚だけ挟まる。
 *
 * ここで通すのは Stage 4——判定がすべてルールベースで、AIチャットも苅部さんの
 * PHS待ちも要らないので、高速レーン（--project=chromium）の制限時間に収まる。
 * Stage 2 側の④と、Stage 1・3・5・6 で出ないことは、監査レーンの journey が
 * 通しで確かめる（passClearPopups の既定が「④は出ない」の検査になっている）。
 *
 * ここで守りたいのは3点。
 *  1. ④が増えてもレースの到達時刻は動かない（記録は判定成立と同時）。
 *  2. ④を閉じると、従来どおり次のステージへ進む。
 *  3. ④を開いたままリロードしても詰まらず、次のステージから再開する。
 */

const S4_SUMMARY =
  "東陵国の速報。発熱に先行して、深い眼の痛みと光をまぶしく感じる症状が複数例で報告されている。";
const S4_ACTION = "夜勤スタッフを含む職員に対し、眼痛や羞明がないかを問診で確認します。";

/** Stage 4 を正解経路で提出し、クリア演出（①告知）が出るところまで進める。 */
const submitStage4 = async (page: Page): Promise<void> => {
  const close = page.locator("#btn-s4director-close");
  await expect(close).toBeVisible({ timeout: 20_000 });
  // 開いた直後の押下は連打対策（400ms）で捨てられるので、閉じるまで押し直す。
  await expect(async () => {
    await close.click();
    await expect(page.locator("#ov-s4-director")).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  await page.locator("#s4-summary").fill(S4_SUMMARY);
  await page.getByRole("button", { name: "院長へ報告" }).click();
  await expect(page.locator("#s4-talk")).toBeVisible({ timeout: 20_000 });
  await page.locator("#s4-action").fill(S4_ACTION);
  await page.getByRole("button", { name: "送信する" }).click();
};

test.describe("操作担当の交代（#ov-handover）", () => {
  test("Stage 4：幹部の反応の次に交代の案内が出て、閉じるとStage 5へ進む", async ({ page }) => {
    await page.goto(`${SERVED_MOCK}#s4`);
    await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Stage 4　新情報の解釈");

    await submitStage4(page);

    // ④は③の後。③が開いている間はまだ出ていない。
    await expect(page.locator("#ov-field")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#ov-handover")).toBeHidden();
    await page.locator("#btn-field-next").click();
    await expect(page.locator("#ov-exec")).toBeVisible();
    await expect(page.locator("#ov-handover")).toBeHidden();
    await expect(async () => {
      await page.locator("#btn-exec-next").click();
      await expect(page.locator("#ov-exec")).toBeHidden({ timeout: 1_000 });
    }).toPass();

    // 進行の案内であって登場人物の台詞ではないので、肖像もタイトルの部署名も無い。
    await expect(page.locator("#ov-handover")).toBeVisible();
    await expect(page.locator("#ov-handover .por")).toHaveCount(0);
    await expect(page.locator("#ov-handover .tb .grow")).toHaveText("進行のご案内");
    await expect(page.locator("#ov-handover")).toContainText("操作する人を交代してください");
    await expect(page.locator("#ov-handover")).toContainText("まだ操作していない人と席を替わって");
    // 2回目＝最後の交代。次のステージに何があるかは一言も書かない。
    await expect(page.locator("#ov-handover")).toContainText("これで最後です");
    // 交代したかどうかは確認しない（ユーザー決定）。入力欄もチェックも置かない。
    await expect(page.locator("#ov-handover input, #ov-handover textarea")).toHaveCount(0);

    await expect(async () => {
      await page.locator("#btn-handover-next").click();
      await expect(page.locator("#ov-handover")).toBeHidden({ timeout: 1_000 });
    }).toPass();
    await expect(page.locator(".stage-title")).toHaveText("Stage 5　報告", { timeout: 20_000 });
  });

  test("Stage 4：交代の案内を開いたまま放置しても、クリアの報告は判定と同時のまま", async ({
    page,
  }) => {
    // 提出クリックからサーバへのクリア報告（kind:"clear"）までの実測を取る。
    // ④が1枚増えたぶんレースの到達時刻が後ろへずれる、が最も怖い回帰なので、
    // 「演出を読み終える前に記録が終わっている」ことを時刻で押さえる。
    const clearReportedAt: number[] = [];
    await page.route("**/api/progress", async (route) => {
      const body: unknown = route.request().postDataJSON();
      if (typeof body === "object" && body !== null && "kind" in body) {
        const { kind } = body as { kind: unknown };
        if (kind === "clear") clearReportedAt.push(Date.now());
      }
      await route.continue();
    });

    await page.goto(`${SERVED_MOCK}#s4`);
    await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Stage 4　新情報の解釈");

    await submitStage4(page);
    const submittedAt = Date.now();

    // ①が出るより前に記録は終わっている。①が②へ自動で送るのは 1900ms 後なので、
    // そこへ乗っていれば下の比較で落ちる。
    await expect.poll(() => clearReportedAt.length).toBe(1);
    const [reportedAt] = clearReportedAt;
    if (reportedAt === undefined) throw new Error("クリアの報告が記録されていません。");
    expect(reportedAt - submittedAt).toBeLessThan(1_500);

    // ③まで送って④を開き、開いたまま置く。②③④はどれも自動で閉じるタイマーを
    // 持たないので、チームが読んでいる間は何秒でも止まりうる——その間にクリアの
    // 報告が後追いで飛ばないことを、実際に止めて確かめる。
    await expect(page.locator("#ov-field")).toBeVisible({ timeout: 20_000 });
    await page.locator("#btn-field-next").click();
    await expect(page.locator("#ov-exec")).toBeVisible();
    await expect(async () => {
      await page.locator("#btn-exec-next").click();
      await expect(page.locator("#ov-exec")).toBeHidden({ timeout: 1_000 });
    }).toPass();
    await expect(page.locator("#ov-handover")).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(clearReportedAt).toHaveLength(1);

    // 閉じて次のステージへ進んでも、報告は増えも減りもしない（二重記録を作らない）。
    await expect(async () => {
      await page.locator("#btn-handover-next").click();
      await expect(page.locator("#ov-handover")).toBeHidden({ timeout: 1_000 });
    }).toPass();
    await expect(page.locator(".stage-title")).toHaveText("Stage 5　報告", { timeout: 20_000 });
    expect(clearReportedAt).toHaveLength(1);
  });

  test("Stage 4：交代の案内が出ている最中にリロードしても、Stage 5 から再開する", async ({
    page,
  }) => {
    await page.goto(`${SERVED_MOCK}#s4`);
    const teamCode = await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Stage 4　新情報の解釈");

    await submitStage4(page);
    await expect(page.locator("#ov-field")).toBeVisible({ timeout: 20_000 });
    await page.locator("#btn-field-next").click();
    await expect(page.locator("#ov-exec")).toBeVisible();
    await expect(async () => {
      await page.locator("#btn-exec-next").click();
      await expect(page.locator("#ov-exec")).toBeHidden({ timeout: 1_000 });
    }).toPass();
    await expect(page.locator("#ov-handover")).toBeVisible();

    // ④を開いたまま落ちる。チェックポイントは判定と同時に保存されている
    // （saveCheckpoint("stage-clear")）ので、復帰先は次のステージ。
    // 参加者の画面にはハッシュが付いていない（開発用ハッシュはこのテストが
    // Stage 4 単体を開くために使っただけで、当日の入口は素のURL）。ハッシュを
    // 残したまま開き直すと `gotoBootView` が復帰先より優先されて、確かめたい
    // チェックポイント復帰の経路を通らない——素のURLで開き直す。
    await page.goto(SERVED_MOCK);
    await expect(page.locator("#ov-entry")).toBeVisible();
    const boxes = page.locator("#code input");
    for (const [index, digit] of teamCode.split("").entries()) {
      await boxes.nth(index).fill(digit);
    }
    await page.getByLabel("チーム名").fill("E2E班");
    await page.getByRole("button", { name: "入室する" }).click();
    await expect(page.locator(".stage-title")).toHaveText("Stage 5　報告", { timeout: 30_000 });
    // 演出は持ち越さない。読みかけの幕が残って操作を塞ぐことがない。
    await expect(page.locator("#ov-handover")).toBeHidden();
    await expect(page.locator("#ov-exec")).toBeHidden();
  });
});
