import { expect, test } from "@playwright/test";

/**
 * Assetsのキャッシュ設定（apps/worker/_headers。Issue #33）。
 *
 * production の画像だけを1日キャッシュさせ、表示の直前の条件付きGET（304）をなくす。
 * Vueアプリ本体（`/` と /app/）は従来どおり毎回確認させ、デプロイ後のリロードで新しい版が
 * 出るようにする。_headers は build-testplay.sh が配信物のルートへ置くので、コピー漏れは
 * 画像のヘッダーが既定値に戻ることで分かる。
 */
const REVALIDATE = "public, max-age=0, must-revalidate";

test("production の画像は1日キャッシュされる", async ({ request }) => {
  const response = await request.get("/assets/images/production/final-goal-ceremony.webp");

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("public, max-age=86400");
});

test("Vueアプリ本体は毎回サーバへ確認させる", async ({ request }) => {
  const page = await request.get("/");
  expect(page.status()).toBe(200);
  expect(page.headers()["cache-control"]).toBe(REVALIDATE);

  const script = /<script[^>]+src="(\/app\/[^"]+\.js)"/.exec(await page.text())?.[1];
  expect(script).toBeDefined();
  const js = await request.get(script ?? "");
  expect(js.status()).toBe(200);
  expect(js.headers()["cache-control"]).toBe(REVALIDATE);
});

test("_headers そのものは配信されない", async ({ request }) => {
  const response = await request.get("/_headers");

  expect(response.status()).toBe(404);
});
