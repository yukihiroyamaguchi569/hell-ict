import { expect, test, type APIRequestContext } from "@playwright/test";

import { OPENAI_STUB_ORIGIN, WORKER_ORIGIN } from "../ports";
import { SAVED_TEAM_CODE_KEY, uniqueTeamCode } from "../shell/helpers";

/*
 * Stage 3 の右ペインを、本物の Worker と OpenAI スタブ（e2e/openai-stub.mjs）で通す。
 * チームは API から正規のルートで Stage 3 まで進める（apps/worker/test/game-command-support.ts
 * の CLEAR と同じ手順。Stage 1 は最後のメールが届く24秒を実時間で待つ）。
 * PII を含む送信は Worker で止まり、OpenAI（スタブ）に一度も届かず、会話にも残らない。
 */

test.setTimeout(90_000);

/** The Worker's Origin guard lets the browser's own origin through. */
const HEADERS = { Origin: WORKER_ORIGIN };

const POLITE_REPLY =
  "ご連絡ありがとうございます。内容を確認いたしました。本日中に関係部署と調整のうえ、改めてご報告いたしますので、今しばらくお待ちください。どうぞよろしくお願いいたします。";

/** Stage 2's grid: 20 rows that pass every check before the deadline. */
const GOOD_GRID = Array.from({ length: 20 }, (_, i) => [
  String(i + 1),
  "5A",
  "2026-08-01",
  "陰性",
  "なし",
  "",
]);

const S1_MAILS = ["m1", "m2", "m3", "m4", "m8"];
/** Stage 1's last mail of the first round lands 23 seconds after the start. */
const S1_LAST_MAIL_MS = 24_000;

const playToStage3 = async (request: APIRequestContext, teamCode: string): Promise<void> => {
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
};

const seenCount = async (request: APIRequestContext, marker: string): Promise<number> => {
  const response = await request.get(`${OPENAI_STUB_ORIGIN}/seen?q=${encodeURIComponent(marker)}`);
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "count" in body ? Number(body.count) : -1;
};

test("Stage 3 のAIへ送るとスタブの応答が出て、PII は Worker で止まり OpenAI に届かない", async ({
  page,
  request,
}) => {
  const teamCode = uniqueTeamCode();
  await playToStage3(request, teamCode);
  await page.addInitScript(
    ([key, code]) => {
      localStorage.setItem(key, code);
    },
    [SAVED_TEAM_CODE_KEY, teamCode] as const,
  );
  await page.goto("/");
  const pane = page.getByTestId("chat-pane");
  const input = page.getByRole("textbox", { name: "AIへの指示" });
  const send = pane.getByRole("button", { name: "送信" });
  await expect(pane).toContainText("こんにちは。今日は何をお手伝いしましょうか？");

  // 数字を含めない：UUID の数字の並びは、まれに電話番号の PII パターンに一致してブロックされる。
  // 0〜9 を g〜p へ写すので、16進の a〜f と重ならず一意さは UUID のまま保たれる。
  const okMarker = `ok-marker-${crypto.randomUUID().replace(/\d/g, (digit) => "ghijklmnop"[Number(digit)] ?? "")}`;
  await input.fill(`こんにちは ${okMarker}`);
  await send.click();
  await expect(pane).toContainText("（スタブ応答）承知しました。");
  // 印の照会が働いていることを、届いた側で確かめておく。このスレッドへの OpenAI 呼び出しは
  // どれも会話の履歴（＝この印）を載せるので、この件数がこのスレッドの呼び出し回数になる。
  // スタブ全体の受信件数は、並列に走る他の spec の呼び出しが混ざるので数えに使わない。
  const callsBefore = await seenCount(request, okMarker);
  expect(callsBefore).toBe(1);

  const piiMarker = `pii-marker-${crypto.randomUUID()}`;
  const piiText = `090-0000-5678 の方へ折り返す件 ${piiMarker}`;
  await input.fill(piiText);
  await send.click();
  await expect(pane).toContainText("個人情報を検知したため、送信をブロックしました。");
  await expect(input).toHaveValue(piiText);
  await expect(input).toBeEditable();
  await input.press("End");
  await input.pressSequentially("（編集）");
  await expect(input).toHaveValue(`${piiText}（編集）`);

  // PII の送信では OpenAI を1回も呼ばない：本文の印が届かず、このスレッドの呼び出しも増えない。
  expect(await seenCount(request, piiMarker)).toBe(0);
  expect(await seenCount(request, okMarker)).toBe(callsBefore);
  const chat = await request.get(`/api/teams/${teamCode}/chat`, { headers: HEADERS });
  expect(chat.ok()).toBe(true);
  const saved = await chat.text();
  expect(saved).toContain(okMarker);
  expect(saved).not.toContain(piiMarker);
  // 画面の側にも跡を残さない：sessionStorage のどの値にも本文の印が無い。
  const stored = await page.evaluate(() =>
    Array.from({ length: sessionStorage.length }, (_, i) => {
      const key = sessionStorage.key(i);
      return key === null ? "" : (sessionStorage.getItem(key) ?? "");
    }).join("\n"),
  );
  expect(stored).not.toContain(piiMarker);
});
