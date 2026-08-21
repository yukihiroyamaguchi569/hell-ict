import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const uniqueTeamCode = (): string => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

/**
 * AIチャットペインは、Stage 1のラウンド1（このPRのスコープ）では画面上に存在しない
 * （docs/ui/02_Stage1.md §狙い）。ペインが登場するのはヘルプ第1段階以降（次PR）のため、
 * ここではUI操作ではなくAPIを直接叩き、PII送信前ゲートとAI連携そのものを検証する。
 */
const mainThreadId = async (page: Page, teamCode: string): Promise<string> => {
  await page.request.post("/api/session", { data: { teamCode } });
  const created = await page.request.post(`/api/teams/${teamCode}/chat/threads`, {
    data: { type: "create-thread", commandId: randomUUID(), title: "テスト" },
  });
  const body = (await created.json()) as { snapshot: { threads: { threadId: string }[] } };
  const threadId = body.snapshot.threads[0]?.threadId;
  if (threadId === undefined) throw new Error("unexpected");
  return threadId;
};

test("PIIを含まない送信はスタブAIの応答が届く", async ({ page }) => {
  const teamCode = uniqueTeamCode();
  const threadId = await mainThreadId(page, teamCode);

  const response = await page.request.post(`/api/teams/${teamCode}/chat/messages`, {
    data: { type: "send-message", commandId: randomUUID(), threadId, text: "こんにちは" },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { assistant: { text: string } };
  expect(body.assistant.text).toBe("（スタブ応答）承知しました。");
});

test("個人情報を含む送信は422でブロックされる", async ({ page }) => {
  const teamCode = uniqueTeamCode();
  const threadId = await mainThreadId(page, teamCode);

  const response = await page.request.post(`/api/teams/${teamCode}/chat/messages`, {
    data: {
      type: "send-message",
      commandId: randomUUID(),
      threadId,
      text: "渡辺 三郎さんの件で返信文を書いてください",
    },
  });
  expect(response.status()).toBe(422);
  const body = (await response.json()) as { message: string };
  expect(body.message).toContain("個人情報を検知したため、送信をブロックしました。");
});
