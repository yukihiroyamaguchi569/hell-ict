import { expect, test, type APIRequestContext } from "@playwright/test";

import { stage5FeverRows } from "../../packages/content/src/index.js";
import { stage1Answers, stage3Answers, stage4Answers } from "../../packages/content/src/answers.js";
import { OPENAI_STUB_ORIGIN, WORKER_ORIGIN } from "../ports";
import { SAVED_TEAM_CODE_KEY, uniqueTeamCode } from "../shell/helpers";

/*
 * Stage 5 の罠を、本物の Worker と OpenAI スタブ（e2e/openai-stub.mjs）で通す。チームは API から
 * 正規のルートで Stage 5 まで進める（apps/worker/test/game-command-support.ts の CLEAR と同じ手順。
 * Stage 1 は最後のメールが届く24秒を実時間で待つ）。個人情報を含む送信は Worker で止まり、
 * OpenAI（スタブ）に一度も届かず、会話にも sessionStorage にも残らず、罰が始まる。
 */

test.setTimeout(90_000);

/** The Worker's Origin guard lets the browser's own origin through. */
const HEADERS = { Origin: WORKER_ORIGIN };

const POLITE_REPLY = stage1Answers.politeReply;

/** Stage 2's grid: 20 rows that pass every check before the deadline. */
const GOOD_GRID = Array.from({ length: 20 }, (_, i) => [
  String(i + 1),
  "5A",
  "2026-08-01",
  "陰性",
  "なし",
  "",
]);

const STAGE3_OK = stage3Answers.ok;

/** The fever list's first row as it came: ID, name, ward, date and temperature. */
const PII_ROW = ((row) => [row.id, row.name, row.ward, row.date, row.temp].join("\t"))(
  stage5FeverRows[0],
);

const S1_MAILS = ["m1", "m2", "m3", "m4", "m8"];
/** Stage 1's last mail of the first round lands 23 seconds after the start. */
const S1_LAST_MAIL_MS = 24_000;

const playToStage5 = async (request: APIRequestContext, teamCode: string): Promise<void> => {
  const session = await request.post("/api/session", { headers: HEADERS, data: { teamCode } });
  expect(session.ok()).toBe(true);
  const body: unknown = await session.json();
  const generation =
    typeof body === "object" && body !== null && "generation" in body ? body.generation : 0;
  const command = async (type: string, payload: Record<string, unknown> = {}): Promise<void> => {
    const response = await request.post(`/api/teams/${teamCode}/game/commands`, {
      headers: HEADERS,
      data: { type, commandId: crypto.randomUUID(), generation, ...payload },
    });
    expect(response.ok(), `${type}: ${await response.text()}`).toBe(true);
    expect(await response.json()).toMatchObject({ status: "applied" });
  };

  await command("inbox.open");
  for (const mailId of ["p0", "p1", "p2"]) {
    await command("inbox.reply", { mailId, text: "承知しました。" });
  }
  await command("advance", { from: "prologue", to: "s1" });
  await command("s1.start");
  await new Promise((resolve) => setTimeout(resolve, S1_LAST_MAIL_MS));
  for (const mailId of S1_MAILS) {
    await command("s1.reply", { mailId, text: POLITE_REPLY });
  }
  await command("advance", { from: "s1", to: "s2" });
  await command("s2.start");
  await command("s2.submit", { grid: GOOD_GRID });
  await command("advance", { from: "s2", to: "s3" });
  await command("s3.submit", { submission: STAGE3_OK });
  await command("advance", { from: "s3", to: "s4" });
  await command("s4.submit-summary", { text: stage4Answers.summaryOk });
  await command("s4.submit-action", { text: stage4Answers.actionOk });
  await command("advance", { from: "s4", to: "s5" });
};

const seenCount = async (request: APIRequestContext, marker: string): Promise<number> => {
  const response = await request.get(`${OPENAI_STUB_ORIGIN}/seen?q=${encodeURIComponent(marker)}`);
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "count" in body ? Number(body.count) : -1;
};

test("Stage 5 でダミー個人情報を送ると罠が発動し、OpenAI には1回も届かず、会話にも sessionStorage にも残らない", async ({
  page,
  request,
}) => {
  const teamCode = uniqueTeamCode();
  await playToStage5(request, teamCode);
  await page.addInitScript(
    ([key, code]) => {
      localStorage.setItem(key, code);
    },
    [SAVED_TEAM_CODE_KEY, teamCode] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("s5-center")).toBeVisible();
  const pane = page.getByTestId("chat-pane");
  const input = page.getByRole("textbox", { name: "AIへの指示" });
  const send = pane.getByRole("button", { name: "送信" });
  await expect(pane).toContainText("こんにちは。今日は何をお手伝いしましょうか？");

  // A clean message reaches the stub: the count of a marker is this thread's calls.
  const okMarker = `ok-marker-${crypto.randomUUID()}`;
  await input.fill(`一覧の整え方を教えて ${okMarker}`);
  await send.click();
  await expect(pane).toContainText("（スタブ応答）承知しました。");
  const callsBefore = await seenCount(request, okMarker);
  expect(callsBefore).toBe(1);

  // The fever list pasted as it came: a patient's name (dummy data of the training) and a marker.
  const piiMarker = `pii-marker-${crypto.randomUUID()}`;
  const piiText = `整えてください ${piiMarker}\n${PII_ROW}`;
  await input.fill(piiText);
  await send.click();

  await expect(page.getByTestId("s5-alarm")).toContainText("個人情報インシデント発生");
  const scold = page.getByTestId("s5-scold");
  await expect(scold).toBeVisible();
  await scold.getByRole("button", { name: "了解しました" }).click();
  await expect(page.getByTestId("penalty-lock")).toContainText("罰ゲーム：報告書の作成");

  // OpenAI was never called: the text's marker never arrived, and the thread's calls did not grow.
  expect(await seenCount(request, piiMarker)).toBe(0);
  expect(await seenCount(request, stage5FeverRows[0].name)).toBe(0);
  expect(await seenCount(request, okMarker)).toBe(callsBefore);
  // Not in the conversation the server keeps.
  const chat = await request.get(`/api/teams/${teamCode}/chat`, { headers: HEADERS });
  expect(chat.ok()).toBe(true);
  const saved = await chat.text();
  expect(saved).toContain(okMarker);
  expect(saved).not.toContain(piiMarker);
  expect(saved).not.toContain(stage5FeverRows[0].name);
  // The server started the penalty (s5.check-ai-message applied by the Worker).
  const game = await request.get(`/api/teams/${teamCode}/game`, { headers: HEADERS });
  expect(await game.json()).toMatchObject({
    state: { game: { penalties: { s5: "in-progress" } } },
  });
  // Not on the screen's side either: no sessionStorage value holds the text.
  const stored = await page.evaluate(() =>
    Array.from({ length: sessionStorage.length }, (_, i) => {
      const key = sessionStorage.key(i);
      return key === null ? "" : `${key}=${sessionStorage.getItem(key) ?? ""}`;
    }).join("\n"),
  );
  expect(stored).not.toContain(piiMarker);
  expect(stored).not.toContain(stage5FeverRows[0].name);
});
