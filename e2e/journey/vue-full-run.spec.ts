import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import {
  epilogueLines,
  missionTitles,
  stage3FieldLabels,
  stage3TrapDoctorLines,
  stage5FeverRows,
  stage5FeverTable,
  stage5IncidentReport,
  stage5ReportVerdicts,
  stage6JimuCall,
  stage6Labels,
  stage4DirectorPages,
  stage4QuestionLines,
} from "../../packages/content/src/index.js";
import {
  stage3Answers,
  stage4Answers,
  stage5Answers,
  stage6Answers,
} from "../../packages/content/src/answers.js";
import {
  gameStagePosition,
  gameViewResponseSchema,
  STAGE1_SCHEDULES,
  teamGameCommandSchema,
  type TeamGameCommand,
} from "../../packages/domain/src/index.js";
import { OPENAI_STUB_ORIGIN, WORKER_ORIGIN } from "../ports";
import { modelGrid } from "../s2/fake-stage2";
import { enterTeam, uniqueTeamCode } from "../shell/helpers";

/**
 * Vue 版の通し（監査レーン専用。V9 / Issue #246）。本物の Worker と OpenAI スタブ
 * （e2e/openai-stub.mjs）で、入室から Prologue → S1 → … → S6 → Final（ゴール → 一言 → 感謝状）
 * までを画面の操作だけで1本に通す。ステージ単位の E2E（e2e/s1〜s6, final）は page.route の
 * 偽サーバで各ステージへ直接入るので、ステージの境目の受け渡し（advance、罰の状態、停留所）
 * は、ここで続けて踏まないと壊れても気づけない。
 *
 * 見るもの:
 *  - ステージの境目ごとに1回再読み込みし、次のステージの入口の場面へ戻ること（10/31 の採用条件
 *    「再読み込みで復帰できる」）。
 *  - Stage 3 で罠を1回踏み、罰（消毒液ボトル）を払って戻ること。
 *  - Stage 5 で個人情報を AI へ送り、罠 → 叱責 → 黒塗りの罰 → 復帰。個人情報はスタブ
 *    （OpenAI）へ一度も届かない（スタブの /seen で数える）。提出する一覧は、教材の一覧から
 *    氏名列を除いて AI（スタブ）に整えさせた表。
 *  - ページのエラー（pageerror・console.error）、応答の無い失敗（requestfailed）、想定外の
 *    4xx/5xx が0件。
 *  - 最後にサーバの状態（GET /game）で、全ステージがクリア済み・罰は各1回・advance は境目ごとに
 *    1回だけ適用されたこと。
 *
 * page.route と page.clock は使わない（サーバの時計は進められない）。実時間で待つのは Stage 1 の
 * 5通の着弾（最後は23秒後。届いた順にすぐ返すので、どの1通も返信の持ち時間を使い切らない）と、
 * 演出の押下ガード（400ms）だけで、所要はおよそ1分半。待ちは画面の状態で受ける（固定の sleep は
 * 押下ガードの分だけ）。
 */

const TEAM = "通し班";

/** Stage 1 で丁寧と判定される返信（70文字以上、「ます」を含む）。 */
const POLITE =
  "お問い合わせいただきありがとうございます。確認のうえ、担当部署と調整して改めてご連絡いたしますので、恐れ入りますが今しばらくお待ちいただけますでしょうか。";

/** Stage 3 の正答（e2e/s3 と同じ）と、早見表を写しただけの罠の欄。 */
const S3_ANSWER = stage3Answers.ok;
const S3_TRAP_PPE = stage3Answers.contaminatedPpe;

const S4_SUMMARY = stage4Answers.summaryOk;
const S4_ACTION = stage4Answers.actionOk;

/**
 * 教材の発熱患者一覧（添付ビューアの表）から氏名列を除いたもの。参加者が列選択コピーで作るのと
 * 同じ形で、AI（スタブ）へ整形を頼む本文になる。
 */
const S5_ANONYMIZED = (() => {
  const nameColumn = stage5FeverTable.header.indexOf("氏名");
  const withoutName = (cells: readonly string[]) => cells.filter((_, i) => i !== nameColumn);
  return [stage5FeverTable.header, ...stage5FeverTable.rows]
    .map((cells) => withoutName(cells).join("\t"))
    .join("\n");
})();
/** 教材のダミー個人情報（研修用の架空の氏名）。 */
const S5_PII_NAME = stage5Answers.piiName;
/** 教材の一覧の先頭行（氏名つき）を、そのまま貼ったもの。 */
const PII_ROW = ((row) => [row.id, row.name, row.ward, row.date, row.temp].join("\t"))(
  stage5FeverRows[0],
);

/** 1回の指示で、ピクトグラム・マスク・面会時間の3つを満たす。 */
const S6_PROMPT = stage6Answers.promptOk;

const FINAL_LINE = "AIに渡す前に、名前を消す。";
/** チーム名と「ゴール」「御中」の間の全角空白。 */
const WIDE = "\u3000";

/** 画面の確認とコマンドの往復のぶんの余裕。 */
const SLACK_MS = 30_000;
/** Stage 1 の最初の回の5通（着弾の早い順）。 */
const S1_ROUND1 = [...STAGE1_SCHEDULES[1]].sort((a, b) => a.at - b.at);
/** 最後の1通が着弾するまで。 */
const S1_LAST_LANDING_MS = Math.max(...S1_ROUND1.map((mail) => mail.at)) * 1_000;
/** 演出の窓は開いた直後 400ms の押下を無視する。 */
const GUARD_MS = 500;

const HEADERS = { Origin: WORKER_ORIGIN };

const row = (page: Page, id: string) => page.locator(`[data-mail-id="${id}"]`);
const replyBox = (page: Page) => page.getByRole("textbox", { name: "返信" });
const sendButton = (page: Page) => page.getByRole("button", { name: "送信する" });
const missionBar = (page: Page) => page.getByTestId("mission-bar");
const chatInput = (page: Page) => page.getByRole("textbox", { name: "AIへの指示" });
const chatPane = (page: Page) => page.getByTestId("chat-pane");
const lock = (page: Page) => page.getByTestId("penalty-lock");

const replyTo = async (page: Page, id: string, text: string): Promise<void> => {
  await row(page, id).click();
  await replyBox(page).fill(text);
  await sendButton(page).click();
};

/**
 * クリアの演出（① → ② → ③ → 交代の案内があれば④）を［次へ］で進め、次のステージの入口
 * （`arrived`）が出るまで。押せる前の押下は無視されるので、出るまで押し直す。
 */
const passClearEffect = async (page: Page, arrived: Locator): Promise<void> => {
  await expect(page.getByTestId("clear-unlock")).toBeVisible({ timeout: SLACK_MS });
  const next = page.locator('[data-testid^="clear-"]').getByRole("button", { name: "次へ" });
  await expect(async () => {
    if (await arrived.isVisible()) return;
    await next.click({ timeout: 1_000 });
    await expect(arrived).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: SLACK_MS });
};

/** 境目での再読み込み。入口の場面（`scene`）とミッションバーが戻ること。 */
const reloadAndExpect = async (page: Page, scene: Locator, title: string): Promise<void> => {
  await page.reload();
  await expect(missionBar(page)).toContainText(title, { timeout: 15_000 });
  await expect(scene).toBeVisible();
};

/** 画面が送ったコマンド。同じ commandId の送り直しは1回と数える（サーバが1回だけ適用する）。 */
const recordCommands = (page: Page) => {
  const sent: TeamGameCommand[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/game/commands")) return;
    const parsed = teamGameCommandSchema.safeParse(request.postDataJSON());
    if (parsed.success) sent.push(parsed.data);
  });
  return {
    distinct: (match: (command: TeamGameCommand) => boolean): number =>
      new Set(sent.filter(match).map((command) => command.commandId)).size,
  };
};

/**
 * 画面が鳴らす効果音（apps/web/src/composables/use-sfx.ts の SFX_NAMES、Worker の許可リスト
 * apps/worker/src/sounds.ts の SOUND_NAMES と同じ7種）。e2e の型検査の範囲（tsconfig.tests.json）
 * は packages だけなので、アプリのソースを import せずここに並べる。
 */
const SOUND_NAMES = [
  "cancel",
  "decision1",
  "don-1",
  "emergency-alert1",
  "hall-clapping-hands1",
  "mobile-phone-ringtone1",
  "success1",
] as const;
const SOUND_PATHS: ReadonlySet<string> = new Set(SOUND_NAMES.map((name) => `/sounds/${name}.mp3`));

/**
 * 効果音の 404。音源は規約上リポジトリに無く、本番は R2 から配る（apps/worker/src/sounds.ts）。
 * wrangler dev --local の R2 は空なので、Worker が配る既知の効果音の GET は必ず 404 になる。
 */
const isSoundGet = (method: string, url: string): boolean => {
  const { origin, pathname } = new URL(url);
  return method === "GET" && origin === WORKER_ORIGIN && SOUND_PATHS.has(pathname);
};
const isMissingSound = (status: number, method: string, url: string): boolean =>
  status === 404 && isSoundGet(method, url);

/** Stage 5 の罠: AI への送信（POST .../game/chat/messages）が個人情報で止まった 422。 */
const PII_BLOCKED_URL = /\/api\/teams\/\d{6}\/game\/chat\/messages$/;
const isPiiBlocked = async (response: Response): Promise<boolean> => {
  if (response.status() !== 422 || response.request().method() !== "POST") return false;
  if (!PII_BLOCKED_URL.test(new URL(response.url()).pathname)) return false;
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "code" in body && body.code === "pii_blocked";
};

/**
 * ブラウザが失敗応答ごとに出す console.error のうち、想定内のもの（効果音の 404・罠の 422）
 * に当たるもの。効果音と罠の応答そのものは response の側で種類を確かめて数える。
 */
const isExpectedLoadError = (text: string, url: string): boolean => {
  const failed = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(
    text,
  );
  if (failed === null || url === "") return false;
  if (failed[1] === "404") return isMissingSound(404, "GET", url);
  return failed[1] === "422" && PII_BLOCKED_URL.test(new URL(url).pathname);
};

/** ページのエラー、console.error、応答の無い失敗、想定外の 4xx/5xx を集める。 */
const watchProblems = (page: Page) => {
  const problems: string[] = [];
  const piiBlocked: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const { url } = message.location();
    if (isExpectedLoadError(message.text(), url)) return;
    problems.push(`console.error: ${message.text()} (${url})`);
  });
  page.on("requestfailed", (request: Request) => {
    const reason = request.failure()?.errorText ?? "unknown";
    // 404 になる効果音の読み込みを、<audio> が自分で打ち切ることがある（次の音へ差し替えたとき）。
    if (reason === "net::ERR_ABORTED" && isSoundGet(request.method(), request.url())) return;
    problems.push(`requestfailed: ${request.method()} ${request.url()} (${reason})`);
  });
  page.on("response", (response: Response) => {
    const status = response.status();
    if (status < 400) return;
    const method = response.request().method();
    if (isMissingSound(status, method, response.url())) return;
    const line = `${String(status)} ${method} ${response.url()}`;
    pending.push(
      isPiiBlocked(response).then((pii) => {
        (pii ? piiBlocked : problems).push(line);
      }),
    );
  });
  return { problems, piiBlocked, settled: () => Promise.all(pending) };
};

const seenCount = async (page: Page, marker: string): Promise<number> => {
  const response = await page.request.get(
    `${OPENAI_STUB_ORIGIN}/seen?q=${encodeURIComponent(marker)}`,
  );
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "count" in body ? Number(body.count) : -1;
};

const serverGame = async (page: Page, code: string) => {
  const response = await page.request.get(`/api/teams/${code}/game`, { headers: HEADERS });
  expect(response.ok()).toBe(true);
  return gameViewResponseSchema.parse(await response.json());
};

// ── ステージごとの手順 ─────────────────────────────────────────

const playPrologue = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "メールを開く" }).click();
  await expect(missionBar(page)).toContainText("返信済み0 / 3");
  for (const id of ["p0", "p1", "p2"]) {
    await replyTo(page, id, "承知しました");
    // 次の行を開く前に、返した行が「返信済み」になるのを待つ。最後の1通はクリアで Stage 1 へ
    // 移るので、下のブリーフィングがその確かめになる。
    if (id !== "p2") await expect(row(page, id)).toContainText("返信済み");
  }
  await expect(page.getByTestId("s1-briefing")).toBeVisible({ timeout: 15_000 });
};

const playStage1 = async (page: Page): Promise<void> => {
  const briefing = page.getByTestId("s1-briefing");
  // 本文を押して早送りしてから［了解しました］。
  await briefing.click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "了解しました" }).click();
  await expect(briefing).toHaveCount(0);
  // 1回目（AIなし）の5通を、届いた順にすぐ丁寧に返す（出そろうのを待つと、先に届いた1通の
  // 持ち時間を待ちで食う）。
  for (const { id } of S1_ROUND1) {
    await expect(row(page, id)).toBeVisible({ timeout: S1_LAST_LANDING_MS + SLACK_MS });
    await replyTo(page, id, POLITE);
    await expect(row(page, id)).toContainText("返信済み");
  }
  // メモと5通が出そろっている。
  await expect(page.getByTestId("inbox-list").getByRole("button")).toHaveCount(6);
  const cleared = page.getByTestId("s1-clear");
  await expect(cleared).toContainText("受信トレイが落ち着きました", { timeout: SLACK_MS });
  await cleared.getByRole("button", { name: "確認した（次へ）" }).click();
  await passClearEffect(page, page.getByTestId("s2-work"));
};

/** 手で直した表を貼り付ける（ブラウザの Ctrl+V と同じ paste イベント）。 */
const pasteGrid = async (page: Page, text: string): Promise<void> => {
  await page
    .getByTestId("s2-grid")
    .locator('input[data-r="0"][data-c="0"]')
    .evaluate((input, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
};

const playStage2 = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("s2-size")).toHaveText("22行 × 6列");
  await pasteGrid(
    page,
    modelGrid()
      .map((cells) => cells.join("\t"))
      .join("\n"),
  );
  await expect(page.getByTestId("s2-size")).toHaveText("20行 × 6列");
  await page.getByRole("button", { name: "提出する", exact: true }).click();
  await passClearEffect(page, page.getByTestId("s3-call"));
};

const fillStage3 = async (page: Page, ppe: string): Promise<void> => {
  await page.getByRole("textbox", { name: stage3FieldLabels.ppe }).fill(ppe);
  await page.getByRole("textbox", { name: stage3FieldLabels.release }).fill(S3_ANSWER.release);
  await page.getByRole("textbox", { name: stage3FieldLabels.clean }).fill(S3_ANSWER.clean);
};

const playStage3 = async (page: Page): Promise<void> => {
  const call = page.getByTestId("s3-call");
  await call.getByRole("button", { name: "了解しました" }).click();
  await expect(call).toHaveCount(0);

  // 罠を1回踏む: 暗転 → 皮膚科医 → 罰（消毒液ボトルの補充）。
  await fillStage3(page, S3_TRAP_PPE);
  await page.getByRole("button", { name: "提出する" }).click();
  await expect(page.getByTestId("s3-blackout")).toBeVisible();
  await expect(call).toContainText(stage3TrapDoctorLines[0]);
  await call.getByRole("button", { name: "了解しました" }).click();
  await expect(lock(page)).toContainText("罰ゲーム：🧴 消毒液ボトルの補充");
  const waiting = page.getByTestId("bottle").and(page.locator(":enabled"));
  await expect
    .poll(
      async () => {
        if ((await waiting.count()) > 0) await waiting.first().click();
        return lock(page).count();
      },
      { timeout: 25_000, intervals: [30] },
    )
    .toBe(0);

  await fillStage3(page, S3_ANSWER.ppe);
  await page.getByRole("button", { name: "提出する" }).click();
  await passClearEffect(page, page.getByTestId("s4-director"));
};

const playStage4 = async (page: Page): Promise<void> => {
  const director = page.getByTestId("s4-director");
  await expect(director).toContainText(stage4DirectorPages[0][0]);
  await page.waitForTimeout(GUARD_MS);
  await director.getByRole("button", { name: "次へ" }).click();
  await expect(director).toContainText(stage4DirectorPages[1][1]);
  await page.waitForTimeout(GUARD_MS);
  await director.getByRole("button", { name: "了解しました" }).click();
  await expect(director).toHaveCount(0);

  await page.getByRole("textbox", { name: "院長への要約" }).fill(S4_SUMMARY);
  await page.getByRole("button", { name: "院長へ報告" }).click();
  const talk = page.getByTestId("s4-talk");
  await expect(talk).toContainText(stage4QuestionLines[2]);
  await page.getByRole("textbox", { name: "院長への返答" }).fill(S4_ACTION);
  await talk.getByRole("button", { name: "送信する" }).click();
  await passClearEffect(page, page.getByTestId("s5-center"));
};

const sendToAi = async (page: Page, text: string): Promise<void> => {
  await chatInput(page).fill(text);
  await chatPane(page).getByRole("button", { name: "送信" }).click();
};

/** 報告書の押せる語のうち、個人情報のものを画面の順に押す。 */
const blackOutPii = async (page: Page): Promise<void> => {
  const pressable = stage5IncidentReport.flatMap((seg) => (seg.pii === undefined ? [] : [seg.pii]));
  const tokens = page.getByTestId("s5-report").getByRole("button");
  await expect(tokens).toHaveCount(pressable.length);
  for (const [i, pii] of pressable.entries()) if (pii) await tokens.nth(i).click();
};

const playStage5 = async (page: Page): Promise<void> => {
  await expect(chatPane(page)).toContainText("こんにちは。今日は何をお手伝いしましょうか？");
  // 氏名列を除いた一覧の整形を頼む。個人情報の無い送信はスタブへ届く（このテストだけが送る
  // 印で数える）。返ってきた表が、保健所へ出す一覧になる。
  const okMarker = `ok-marker-${crypto.randomUUID()}`;
  await sendToAi(page, `この一覧を整えてください ${okMarker}\n${S5_ANONYMIZED}`);
  const formatted = chatPane(page)
    .getByTestId("chat-bubble")
    .filter({ hasText: "日付はYYYY-MM-DD" })
    .locator("pre.tsv");
  await expect(formatted).toContainText("患者ID");
  const list = await formatted.innerText();
  expect(await seenCount(page, okMarker)).toBe(1);

  // 一覧を氏名ごと貼って送る: 罠。
  const piiMarker = `pii-marker-${crypto.randomUUID()}`;
  await sendToAi(page, `整えてください ${piiMarker}\n${PII_ROW}`);
  await expect(page.getByTestId("s5-alarm")).toContainText("個人情報インシデント発生");
  const scold = page.getByTestId("s5-scold");
  await scold.getByRole("button", { name: "了解しました" }).click();
  await expect(lock(page)).toContainText("罰ゲーム：報告書の作成");
  await blackOutPii(page);
  await lock(page).getByRole("button", { name: "報告書を提出" }).click();
  await expect(lock(page).getByTestId("verdict")).toContainText(stage5ReportVerdicts.sent);
  await expect(lock(page)).toHaveCount(0);
  await expect(chatPane(page)).toContainText("個人情報を検知したため、送信をブロックしました。");

  // OpenAI（スタブ）には一度も届いていない。
  expect(await seenCount(page, piiMarker)).toBe(0);
  expect(await seenCount(page, S5_PII_NAME)).toBe(0);
  expect(await seenCount(page, okMarker)).toBe(1);

  await page.getByRole("textbox", { name: "保健所へ提出する一覧" }).fill(list);
  await page.getByRole("button", { name: "保健所へ提出" }).click();
  await expect(page.getByTestId("verdict")).toContainText("Stage 5 をクリアしました");
  await passClearEffect(page, page.getByTestId("s6-task"));
};

const playStage6 = async (page: Page): Promise<void> => {
  const task = page.getByTestId("s6-task");
  await expect(task).toContainText(stage6JimuCall.lines[0]);
  await task.getByRole("button", { name: stage6JimuCall.close }).click();
  await expect(task).toHaveCount(0);

  await chatInput(page).fill(S6_PROMPT);
  await chatInput(page).press("Enter");
  const pick = page.getByRole("button", { name: stage6Labels.pick });
  await expect(pick).toHaveCount(1, { timeout: 15_000 });
  await pick.click();
  await expect(page.getByTestId("s6-thumb")).toHaveAttribute("src", /pictogram/);
  await page.getByRole("button", { name: stage6Labels.submit }).click();
  await expect(page.getByTestId("verdict")).toContainText(stage6Labels.cleared);
  await passClearEffect(page, page.getByTestId("final-goal"));
};

const playFinal = async (page: Page): Promise<void> => {
  const goal = page.getByTestId("final-goal");
  await expect(goal.getByTestId("final-goal-name")).toHaveText(TEAM);
  await expect(
    goal.getByRole("heading", { name: `${TEAM}${WIDE}ゴール`, exact: true }),
  ).toBeVisible();
  await goal.getByRole("button", { name: "振り返りへ進む" }).click();
  const epilogue = page.getByTestId("final-epilogue");
  await expect(epilogue).toContainText(epilogueLines[0]);
  await page.waitForTimeout(GUARD_MS);
  await epilogue.getByRole("button", { name: "振り返りへ" }).click();
  await expect(epilogue).toHaveCount(0);

  const lineBox = page.getByRole("textbox", { name: "引き継ぎ" });
  await lineBox.fill(FINAL_LINE);
  await lineBox.press("Enter");
  // リレーは背景を押して進め、最後の声の［感謝状を受け取る］で感謝状へ。
  const relay = page.getByTestId("final-relay");
  const receive = relay.getByRole("button", { name: "感謝状を受け取る" });
  await expect(async () => {
    if (!(await receive.isVisible())) await relay.click({ position: { x: 8, y: 8 } });
    await expect(receive).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: SLACK_MS });
  await receive.click();
  await expect(page.getByTestId("final-address")).toHaveText(`${TEAM}${WIDE}御中`);
  await expect(page.getByTestId("final-quote")).toHaveText(`「${FINAL_LINE}」`);
  // The frame picture under the certificate has arrived: a reload while it is still on its way
  // would abort the request (the next step reloads at once, which no team does).
  const frame = page.getByTestId("final-handover").locator("img.frame-art");
  await expect
    .poll(() => frame.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
};

test("Vue 版を入室から感謝状まで1本で通す（実 Worker・OpenAI スタブ・境目ごとに再読み込み）", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const code = uniqueTeamCode();
  const watched = watchProblems(page);
  const commands = recordCommands(page);

  await page.goto("/");
  await enterTeam(page, code, TEAM);

  await playPrologue(page);
  await reloadAndExpect(page, page.getByTestId("s1-briefing"), missionTitles.s1);

  await playStage1(page);
  await reloadAndExpect(page, page.getByTestId("s2-work"), missionTitles.s2);

  await playStage2(page);
  await reloadAndExpect(page, page.getByTestId("s3-call"), missionTitles.s3);

  await playStage3(page);
  await reloadAndExpect(page, page.getByTestId("s4-director"), missionTitles.s4);

  await playStage4(page);
  await reloadAndExpect(page, page.getByTestId("s5-center"), missionTitles.s5);

  await playStage5(page);
  await reloadAndExpect(page, page.getByTestId("s6-task"), missionTitles.s6);

  await playStage6(page);
  await reloadAndExpect(page, page.getByTestId("final-goal"), missionTitles.final);

  await playFinal(page);
  // 感謝状まで来た後の再読み込みは、感謝状へ直接戻る。
  await reloadAndExpect(page, page.getByTestId("final-quote"), missionTitles.final);
  await expect(page.getByTestId("final-quote")).toHaveText(`「${FINAL_LINE}」`);

  // ── サーバの状態: 全ステージがクリア済み、罰は各1回、二重適用なし ──
  const { state, pos } = await serverGame(page, code);
  expect(state.game.stage).toBe("final");
  expect(pos).toBe(gameStagePosition("final"));
  expect(Object.keys(state.game.clearedAt).sort()).toEqual(
    ["prologue", "s1", "s2", "s3", "s4", "s5", "s6"].sort(),
  );
  expect(state.game.penalties).toEqual({ s3: "done", s5: "done" });
  expect(state.s1?.status).toEqual({ phase: "cleared", result: "manual" });
  expect(state.s1?.doneIds).toHaveLength(STAGE1_SCHEDULES[1].length);
  expect(state.s3.trapJudgements).toBe(1);
  expect(state.s4.summaryAccepted).toBe(true);
  expect(state.s6.candidates).toEqual(["pictogram"]);

  // 境目の advance は、それぞれ1回だけ（送り直しは同じ commandId）。
  const boundaries = [
    ["prologue", "s1"],
    ["s1", "s2"],
    ["s2", "s3"],
    ["s3", "s4"],
    ["s4", "s5"],
    ["s5", "s6"],
    ["s6", "final"],
  ] as const;
  for (const [from, to] of boundaries) {
    expect(
      commands.distinct((c) => c.type === "advance" && c.from === from && c.to === to),
      `advance ${from}→${to}`,
    ).toBe(1);
  }
  for (const type of ["s1.start", "s2.start", "s3.finish-penalty", "s5.submit-report"] as const) {
    expect(
      commands.distinct((c) => c.type === type),
      type,
    ).toBe(1);
  }

  await watched.settled();
  expect(watched.problems).toEqual([]);
  expect(watched.piiBlocked).toHaveLength(1);
});
