import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { WORKER_ORIGIN } from "../ports";

/**
 * Vue のシェル（apps/web）を操作する E2E の共通手順。本番と同じく、scripts/build-testplay.sh
 * が apps/worker/public/ へ置いたビルドを wrangler dev の `/` から開く（/api は同一オリジン）。
 * チームコードは spec ごとに乱数で取り、並列実行で同じチームを踏まない。
 */

export const uniqueTeamCode = (): string =>
  String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

/** 入室済みのチームを覚えておく localStorage のキー（apps/web の TEAM_CODE_STORAGE_KEY）。 */
export const SAVED_TEAM_CODE_KEY = "hellTeamCode";

/** ウェルカム画面の見出し。これが見えていれば入室が通り、操作できる画面が出ている。 */
export const welcomeHeading = (page: Page) =>
  page.getByRole("heading", { name: "聖クロノス総合病院 感染制御チーム（ICT）へようこそ" });

export const enterButton = (page: Page) => page.getByRole("button", { name: "入室する" });

export const retryButton = (page: Page) => page.getByRole("button", { name: "再試行" });

/** 読み上げを聞きながら打つのと同じく、1桁目から続けて打つ（桁ごとにフォーカスが進む）。 */
export const fillEntry = async (page: Page, code: string, name: string): Promise<void> => {
  await page.getByRole("textbox", { name: "チームコード 1桁目" }).click();
  await page.keyboard.type(code);
  await page.getByRole("textbox", { name: "チーム名" }).fill(name);
};

/** 疎通確認を待ってから入室する。 */
export const enterTeam = async (page: Page, code: string, name: string): Promise<void> => {
  await fillEntry(page, code, name);
  await expect(enterButton(page)).toBeEnabled();
  await enterButton(page).click();
};

/**
 * 受信トレイを API から開く（`inbox.open`）。画面の［メールを開く］を押さずに、受信トレイを
 * 開いた後のチームを作るときに使う（画面からの操作は e2e/prologue/）。
 */
export const openInboxByApi = async (
  request: APIRequestContext,
  teamCode: string,
): Promise<void> => {
  const headers = { Origin: WORKER_ORIGIN };
  const session = await request.post("/api/session", { headers, data: { teamCode } });
  expect(session.ok()).toBe(true);
  const body: unknown = await session.json();
  const generation =
    typeof body === "object" && body !== null && "generation" in body ? body.generation : 0;
  const response = await request.post(`/api/teams/${teamCode}/game/commands`, {
    headers,
    data: { type: "inbox.open", commandId: crypto.randomUUID(), generation },
  });
  expect(response.ok(), await response.text()).toBe(true);
};

/** 入室の要求（POST /api/session）の本文のチームコード。 */
export const sessionTeamCode = (body: unknown): unknown =>
  typeof body === "object" && body !== null && "teamCode" in body ? body.teamCode : null;
