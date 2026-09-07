import { expect, test, type Page } from "@playwright/test";

import {
  bubbleText,
  copyFromViewer,
  enterTeam,
  openFeverLinelist,
  sendToAi,
  SERVED_MOCK,
} from "./served-mock-helpers";

/**
 * 配信版モックの後半ステージ（Stage 5 報告／Stage 6 掲示／Final）のE2E。
 *
 * Stage 5 は「氏名列を落としてAIへ渡し、整形結果を提出する」正解経路と、
 * 「氏名ごと渡す」罠の両方をLIVEで通す。台本モードの応答（s5ScriptedTable）は
 * LIVEでは通らないので、整形結果は e2e/openai-stub.mjs が送信本文から組み立てる。
 * Stage 6 以降は、ゴール演出→エピローグ→振り返りボード→感謝状という
 * 「当日いちばん最後に見せる並び」を、参加者の操作だけで通す。
 */

/** OpenAIスタブが受け取った本文のうち、`query`を含むものの件数。 */
const stubSeenCount = async (page: Page, query: string): Promise<number> => {
  const response = await page.request.get(
    `http://127.0.0.1:8789/seen?q=${encodeURIComponent(query)}`,
  );
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("count" in body)) {
    throw new Error("スタブの /seen 応答が想定の形ではありません。");
  }
  const { count } = body as { count: unknown };
  if (typeof count !== "number") throw new Error("スタブの /seen 応答が想定の形ではありません。");
  return count;
};

test.describe("配信版モック（後半ステージ）", () => {
  test.beforeEach(async ({ context }) => {
    // 添付ビューアのコピーは navigator.clipboard を使う。参加者と同じ経路
    // （コピー→貼り付け）でなぞるため、読み書きの両方を許可する。
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://127.0.0.1:8787",
    });
  });

  test("Stage 5：氏名列を外した一覧をAIへ渡すと、整形結果の提出でクリアしてStage 6へ進む", async ({
    page,
  }) => {
    await page.goto(`${SERVED_MOCK}#s5`);
    await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Stage 5　報告");

    await openFeverLinelist(page);
    // 氏名列だけを外す。既定は全列ONで、どの列が個人情報かの判断は参加者に残る。
    await page.locator("#viewer-col-picks label", { hasText: "氏名" }).locator("input").uncheck();
    const linelist = await copyFromViewer(page, "#btn-copy-cols");
    expect(linelist).not.toContain("渡辺");
    expect(linelist).toContain("患者ID");

    // このテストの送信だけを指せる印。スタブの受信記録の照会に使う
    // （並列実行中の他テストの送信と混ざらないように）。
    const marker = `e2e-s5-ok-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    await sendToAi(page, `${linelist}\n\n上の一覧を保健所提出用に整形してください。（${marker}）`);

    const reply = page.locator("#ai-log .bubble").filter({ hasText: "承知しました" }).last();
    await expect(reply).toBeVisible({ timeout: 20_000 });
    // 台本応答にだけ付く目印。付いていたら入室が効かず台本へ落ちている。
    await expect(reply.locator(".tag")).toHaveCount(0);
    expect(await stubSeenCount(page, marker)).toBe(1);

    const formatted = await bubbleText(reply);
    expect(formatted).toContain("2026-08-10");

    await page.locator("#s5-reply").fill(formatted);
    await page.getByRole("button", { name: "保健所へ提出" }).click();
    await expect(page.locator("#s5-verdict")).toContainText("Stage 5 をクリアしました");

    // 解錠オーバーレイを経て、Stage 6 へ自動で進む（stage5UnlockSequence）。
    await expect(page.locator("#ov-unlock")).toBeVisible();
    await expect(page.locator(".stage-title")).toHaveText("Stage 6　掲示", { timeout: 15_000 });
  });

  test("Stage 5：氏名を含む一覧を送るとOpenAIへ届かず、叱責と黒塗りの罰へ進む", async ({
    page,
  }) => {
    await page.goto(`${SERVED_MOCK}#s5`);
    await enterTeam(page);

    await openFeverLinelist(page);
    const wholeSheet = await copyFromViewer(page, "#btn-copy");
    expect(wholeSheet).toContain("渡辺 三郎");

    const marker = `e2e-s5-pii-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    await sendToAi(page, `${wholeSheet}\n\nこの一覧を整形してください。（${marker}）`);

    await expect(page.locator("#ov-alarm")).toBeVisible();
    await expect(page.locator("#ov-alarm")).toContainText("個人情報インシデント発生");
    await expect(page.locator("#ov-s5scold")).toBeVisible({ timeout: 10_000 });
    await page.locator("#btn-s5scold-close").click();
    await expect(page.locator("#ov-lock")).toBeVisible();
    await expect(page.locator("#lock-hd")).toHaveText("罰ゲーム：報告書の作成");
    await expect(page.locator("#penalty-host")).toContainText("個人情報にあたる箇所を黒く塗り");

    // 送信前ゲートで止めた本文は、Workers側のPIIゲートより手前で捨てられる。
    // 表示が出たことだけでは足りない——OpenAIへ一度も届いていないことまで見る。
    expect(await stubSeenCount(page, marker)).toBe(0);
    expect(await stubSeenCount(page, "渡辺 三郎")).toBe(0);
  });

  test("Stage 6：ポスターを提出するとゴール演出とエピローグを経て振り返りボードへ着く", async ({
    page,
  }) => {
    await page.goto(`${SERVED_MOCK}#s6`);
    await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Stage 6　掲示");
    await page.locator("#btn-s6jimu-task-close").click();
    await expect(page.locator("#ov-s6jimu-task")).toBeHidden();

    // マスク着用と面会時間の両方に触れ、かつメールの丸写しではない指示。
    await sendToAi(
      page,
      "ピクトグラム中心の掲示にしてください。マスクを着けてもらうこと、面会時間が14時から16時までであることが、一目で伝わるようにしてください。",
    );
    const picked = page.locator("#ai-log .s6-pick");
    await expect(picked).toBeVisible({ timeout: 20_000 });
    await picked.click();

    const submit = page.getByRole("button", { name: "提出する" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator("#s6-verdict")).toContainText("Stage 6 をクリアしました");

    await expect(page.locator("#ov-goal")).toBeVisible();
    await expect(page.locator("#goal-s")).toHaveText("レース終了 — このあと振り返りへ進みます");
    await page.locator("#goal-next").click();

    await expect(page.locator("#ov-epilogue")).toBeVisible();
    await expect(page.locator("#ov-epilogue")).toContainText("記者会見を終えた。");
    // 開いた直後の押下は連打対策（EPILOGUE_GRACE_MS＝400ms）で捨てられるため、
    // オーバーレイが閉じるまで押し直す。
    await expect(async () => {
      await page.locator("#btn-epilogue-next").click();
      await expect(page.locator("#ov-epilogue")).toBeHidden({ timeout: 1_000 });
    }).toPass();

    await expect(page.locator(".stage-title")).toHaveText("Final　振り返り");
    // タイル6枚が0.4秒間隔で点灯し、全点灯後に空白ピースが開く。
    await expect(page.locator("#f-tiles .ftile.lit")).toHaveCount(6, { timeout: 15_000 });
    await expect(page.locator("#f-piece")).toHaveClass(/ready/);
  });

  test("Final：一言を記すと労いリレーと感謝状が出て、［最初に戻る］で入室画面へ帰る", async ({
    page,
  }) => {
    await page.goto(`${SERVED_MOCK}#final`);
    await enterTeam(page);
    await expect(page.locator(".stage-title")).toHaveText("Final　振り返り");

    const input = page.locator("#f-line-input");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("AIに渡す前に、名前を消す。");
    await page.getByRole("button", { name: "記す" }).click();
    await expect(page.locator("#f-close")).toContainText("あなたたちも、引き継ぐ側になった。");

    // 労いリレーは自動で送らない。院長→看護部長→事務長を［次へ］で送る。
    await expect(page.locator("#ov-f-relay")).toBeVisible({ timeout: 10_000 });
    for (const name of ["院長", "看護部長"]) {
      await expect(page.locator("#f-relay-cap")).toHaveText(name);
      await page.locator("#btn-f-relay-next").click();
    }
    await expect(page.locator("#f-relay-cap")).toHaveText("事務長");
    await expect(page.locator("#btn-f-relay-next")).toHaveText("感謝状を受け取る");
    await page.locator("#btn-f-relay-next").click();

    const handover = page.locator("#ov-f-handover");
    await expect(handover).toBeVisible();
    await expect(page.locator("#hdoc-to")).toHaveText("E2E班　御中");
    await expect(page.locator("#hdoc-quote")).toHaveText("「AIに渡す前に、名前を消す。」");

    // ［最初に戻る］はステージ指定ハッシュを捨ててリロードする——残っていると
    // 次のチームがPrologueではなくFinalから始まってしまう。
    await page.locator("#btn-f-restart").click();
    await expect(page.locator("#ov-entry")).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  });
});
