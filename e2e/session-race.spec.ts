import { expect, test } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

const savedTeamCodeKey = "hell-ict-team-code";

/**
 * 保存済みコードからの自動復元が遅れている最中に、フォームから別のチームで入室した
 * ときの競合。遅い応答をあとから採ると、世代とsnapshotが前のチームのもので上書きされ、
 * 「表示は新しいチーム・世代は前のチーム」という、以後の書き込みが全部409になる
 * 状態が残る。開始が新しいほうの応答だけを採ることを、画面に出る段階で確かめる。
 */
test("復元の応答が遅れている間に別チームで入室すると、あとから始めたほうが残る", async ({
  page,
}) => {
  const restored = uniqueTeamCode();
  const entered = uniqueTeamCode();

  // 復元されるチームだけ Stage 1 まで進めておく。どちらが最終状態かを見出しで見分ける
  // ため——両方 Prologue のままだと、競合に負けても画面から区別が付かない。
  await page.goto("/");
  await page.getByLabel("チームコード").fill(restored);
  await page.getByRole("button", { name: "入室する" }).click();
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();

  // 次の読み込みで、保存済みコードからの復元が走る状態にする。
  await page.evaluate(
    ({ key, code }) => {
      localStorage.setItem(key, code);
    },
    { key: savedTeamCodeKey, code: restored },
  );

  // WebSocketは握ったまま何も返さない。復元中の snapshot は本来こちらからも届き、
  // 届いた時点で入室欄が消えてしまう——競合が現実に起きるのは、まさにその配信が
  // 遅れている（または繋がらない）ときなので、その状況を作る。
  await page.routeWebSocket(/\/sync(\?|$)/, () => {
    /* 接続を保持したまま、サーバへも繋がず何も配信しない。 */
  });

  // 復元されるチームの /api/session だけを遅らせる。あとから始まる入室のほうが先に返る。
  // 呼ばれた順ではなく本文のteamCodeで判定する——StrictModeは効果を2回走らせるので、
  // 「1回目だけ遅らせる」だと2回目の復元がそのまま通ってしまう。
  await page.route("**/api/session", async (route) => {
    const body: unknown = route.request().postDataJSON();
    const target =
      typeof body === "object" && body !== null && "teamCode" in body ? body.teamCode : null;
    if (target === restored) await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });

  await page.reload();
  // 復元が返る前に、フォームから別のチームで入る（snapshotが無い間は入室欄が出ている）。
  await page.getByLabel("チームコード").fill(entered);
  await page.getByRole("button", { name: "入室する" }).click();
  await expect(page.getByRole("heading", { name: "Prologue: 着任" })).toBeVisible();

  // 遅れていた復元の応答が届いても、画面は入室したチームのまま。
  await page.waitForTimeout(4000);
  await expect(page.getByRole("heading", { name: "Prologue: 着任" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toHaveCount(0);

  // 世代も入室したチームのものなので、そのまま書き込みが通る（409で止まらない）。
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(page.getByRole("heading", { name: "Stage 1: 平常運転" })).toBeVisible();
  await expect(page.getByText("この端末の状態は古くなっています。")).toHaveCount(0);
});
