import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import auditAwardSql from "../aggregation/audit-award.sql?raw";
import handoverSql from "../aggregation/handover.sql?raw";
import winnerSql from "../aggregation/winner.sql?raw";
import { handleActivityPost } from "../src/activity-log.js";
import { debriefHandoverSchema, debriefResultsSchema } from "../src/debrief.js";
import {
  advance,
  applied,
  CLEAR,
  command,
  ORDER,
  playTo,
  STAGE3_OK,
  STAGE3_TRAP,
} from "./game-command-support.js";
import { clock, gmReset } from "./game-support.js";
import { get, postJson, TEST_ORIGIN } from "./support.js";
import { PII_NAME, PII_SURNAME } from "./pii-support.js";

/**
 * デブリーフィングの集計SQL（apps/worker/aggregation/。Issue #292）が、新アプリが実際に
 * D1へ書く行から着順・監査賞・申し送りを出すことを確かめる。行はテスト用に手で作らず、
 * ゲームのコマンド・進捗・活動ログの経路を本物のDOとD1で通して積む。
 */

const EVENT_NO = "71";

type StageId = (typeof ORDER)[number];

/** `from`に居るチームを、正規のルートで`target`へ入ったところまで進める（playToの途中から版）。 */
const playOn = async (
  teamCode: string,
  from: StageId,
  target: StageId,
  generation = 0,
): Promise<void> => {
  for (const stage of ORDER.slice(ORDER.indexOf(from), ORDER.indexOf(target))) {
    await CLEAR[stage]?.(teamCode, generation);
    clock.advanceBy(5_000);
    await applied(teamCode, advance(stage, ORDER[ORDER.indexOf(stage) + 1] ?? "final", generation));
    clock.advanceBy(1_000);
  }
};

/** Stage 3 で`waitMs`待って正しく提出する（playToは入った1秒後に返すので、所要は1秒長い）。 */
const clearStage3After = async (teamCode: string, waitMs: number, generation = 0) => {
  clock.advanceBy(waitMs);
  await applied(teamCode, command("s3.submit", { submission: STAGE3_OK }, generation));
  clock.advanceBy(5_000);
  await applied(teamCode, advance("s3", "s4", generation));
};

/** Stage 3 で罠を踏み、罰を終えてから正しく提出して抜ける。 */
const clearStage3AfterTrap = async (teamCode: string, generation = 0) => {
  await applied(teamCode, command("s3.submit", { submission: STAGE3_TRAP }, generation));
  clock.advanceBy(125_000);
  await applied(teamCode, command("s3.finish-penalty", {}, generation));
  await clearStage3After(teamCode, 0, generation);
};

/** 入室した画面が送るチーム名の進捗（新アプリはこれだけがチーム名を運ぶ）。 */
const reportName = async (teamCode: string, teamName: string, generation = 0) => {
  const response = await postJson("/api/progress", {
    teamCode,
    teamName,
    pos: 0,
    view: "welcome",
    kind: "entry",
    generation,
    clientAt: clock.now().toISOString(),
  });
  expect(response.status).toBe(200);
};

/** Finalの一言（submit.final）。画面と同じく活動ログのAPIへ送る。 */
const submitFinal = async (teamCode: string, text: string, generation = 0) => {
  const response = await handleActivityPost(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/activity`, {
      method: "POST",
      headers: { Origin: TEST_ORIGIN },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        kind: "submit.final",
        view: "final",
        text,
        clientAt: clock.now().toISOString(),
        generation,
      }),
    }),
    env,
    teamCode,
    clock.now().getTime(),
  );
  expect(response.status).toBe(200);
};

const run = async (sql: string, eventNo = EVENT_NO): Promise<unknown[]> =>
  (await env.PROGRESS_DB.prepare(sql.replaceAll("{{EVENT_NO}}", eventNo)).all()).results;

const winnerRows = z.array(
  z.object({ team_code: z.string(), team_name: z.string(), goal_at_utc: z.string() }).strict(),
);
const auditRows = z.array(
  z
    .object({
      team_code: z.string(),
      team_name: z.string(),
      s3_min: z.number(),
      s3_start: z.string(),
      s3_clear: z.string(),
    })
    .strict(),
);
const handoverRows = z.array(
  z
    .object({
      team_code: z.string(),
      team_name: z.string(),
      text: z.string(),
      pii_redacted: z.number(),
      created_at: z.string(),
    })
    .strict(),
);

/** 番付の画面（scripts/ranking-board）が時刻として読む形: "YYYY-MM-DD HH:MM:SS.SSS"（UTC）。 */
const boardTime = (date: Date): string => date.toISOString().replace("T", " ").replace("Z", "");

const goalTimes = new Map<string, string>();

/** Stage 4 から Final へ入るまで進め、Stage 6 をクリアした時刻（前進の余韻5秒と1秒の前）を控える。 */
const playGoal = async (teamCode: string, generation = 0) => {
  await playOn(teamCode, "s4", "final", generation);
  goalTimes.set(teamCode, boardTime(new Date(clock.now().getTime() - 6_000)));
};

beforeAll(async () => {
  const saved = env.EVENT_NO;
  Object.assign(env, { EVENT_NO });
  afterAll(() => {
    Object.assign(env, { EVENT_NO: saved });
  });
  clock.reset();

  // 一班: 罠なし、Stage 3 に60秒。Finalで2度記し、後の一言が残る。
  await reportName("710001", "一班");
  await playTo("710001", "s3");
  await clearStage3After("710001", 59_000);
  await playGoal("710001");
  await submitFinal("710001", "下書き");
  await submitFinal("710001", "マニュアルは原本を開け");

  // 二班: 罠なし、Stage 3 に30秒。Stage 6 で止まる（ゴールしていない）。
  await reportName("710002", "二班");
  await playTo("710002", "s3");
  await clearStage3After("710002", 29_000);
  await playOn("710002", "s4", "s6");

  // 三班: Stage 3 で罠を踏んでからゴールする。監査賞には出ない。
  await reportName("710003", "三班");
  await playTo("710003", "s3");
  await clearStage3AfterTrap("710003");
  await playGoal("710003");

  // 四班: 罠を踏んでゴールし、一言も記した後にGMリセット。やり直しでは罠なし・48秒で抜けて
  // Stage 4 で止まる。リセット前のゴール・罠・一言はどれも数えない。
  await reportName("710004", "四班");
  await playTo("710004", "s3");
  await clearStage3AfterTrap("710004");
  await playGoal("710004");
  await submitFinal("710004", "リセット前の一言");
  expect((await gmReset("710004")).status).toBe(200);
  await reportName("710004", "四班やり直し", 1);
  await playTo("710004", "s3", 1);
  await clearStage3After("710004", 47_000, 1);
  goalTimes.delete("710004");

  // 五班: 罠なし、Stage 3 に24秒。一言に個人情報を書き、本文ごと保存されない。
  await reportName("710005", "五班");
  await playTo("710005", "s3");
  await clearStage3After("710005", 23_000);
  await playGoal("710005");
  await submitFinal("710005", `${PII_NAME}さんに聞けば分かる`);

  // 別の開催回の行は混ざらない。
  await env.PROGRESS_DB.prepare(
    `INSERT INTO progress_events (team_code, team_name, pos, view, kind, generation, client_at)
     VALUES ('720001', '別の回', 7, 'final', 'clear', 0, '2026-10-31T00:00:00.000Z')`,
  ).run();
});

describe("集計SQL（着順・監査賞・申し送り）", () => {
  it("着順: Stage 6 をクリアした時刻（サーバの時刻）が早い順。未ゴールとリセット前のゴールは出ない", async () => {
    const rows = winnerRows.parse(await run(winnerSql));
    expect(rows).toEqual([
      { team_code: "710001", team_name: "一班", goal_at_utc: goalTimes.get("710001") },
      { team_code: "710003", team_name: "三班", goal_at_utc: goalTimes.get("710003") },
      { team_code: "710005", team_name: "五班", goal_at_utc: goalTimes.get("710005") },
    ]);
  });

  it("監査賞: 罠を踏んでいないチームを、Stage 3 の所要が短い順。リセット前の罠は数えない", async () => {
    const rows = auditRows.parse(await run(auditAwardSql));
    expect(rows.map((row) => [row.team_code, row.team_name, row.s3_min])).toEqual([
      ["710005", "五班", 0.4],
      ["710002", "二班", 0.5],
      ["710004", "四班やり直し", 0.8],
      ["710001", "一班", 1],
    ]);
    const durations = rows.map(
      (row) => Date.parse(`${row.s3_clear}Z`) - Date.parse(`${row.s3_start}Z`),
    );
    expect(durations).toEqual([24_000, 30_000, 48_000, 60_000]);
  });

  it("申し送り: チームごとに最後の一言。リセット前の一言は出ず、個人情報を書いた一言は本文が空", async () => {
    const rows = handoverRows.parse(await run(handoverSql));
    expect(
      rows.map(({ team_code, team_name, text, pii_redacted }) => ({
        team_code,
        team_name,
        text,
        pii_redacted,
      })),
    ).toEqual([
      { team_code: "710001", team_name: "一班", text: "マニュアルは原本を開け", pii_redacted: 0 },
      { team_code: "710005", team_name: "五班", text: "", pii_redacted: 1 },
    ]);
  });

  it("どれも先頭が`-`で始まらない（wranglerの--commandへ渡すと、値がオプションと解釈されて失敗する）", () => {
    for (const sql of [winnerSql, auditAwardSql, handoverSql]) {
      expect(sql.trimStart().startsWith("-")).toBe(false);
    }
  });

  it("開催回を置き換えなければ1行も出ない（置き換え忘れで別の回を映さない）", async () => {
    for (const sql of [winnerSql, auditAwardSql, handoverSql]) {
      await expect(run(sql, "{{EVENT_NO}}")).resolves.toEqual([]);
    }
  });
});

const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

/** `env`の運用値を一時的に差し替える（gm-reset.test.tsのwithEnvと同じ流儀）。 */
const withEnv = async <T>(
  overrides: Partial<Pick<Env, "ADMIN_TOKEN" | "EVENT_NO">>,
  run: () => Promise<T>,
): Promise<T> => {
  const saved = { ADMIN_TOKEN: env.ADMIN_TOKEN, EVENT_NO: env.EVENT_NO };
  Object.assign(env, overrides);
  try {
    return await run();
  } finally {
    Object.assign(env, saved);
  }
};

/** 番付の画面と同じく、同一オリジンのGETにBearerでトークンを添える。 */
const gmGet = (path: string, token: string | null = ADMIN_TOKEN): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      headers:
        token === null
          ? { "Sec-Fetch-Site": "same-origin" }
          : { "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${token}` },
    }),
  );

const RESULTS = "/api/gm/debrief/results";
const HANDOVER = "/api/gm/debrief/handover";

describe("デブリーフィングの集計API（GET /api/gm/debrief/*）", () => {
  it("番付: EVENT_NOの回だけを、集計SQLと同じ並びで返す。チームコードは出さない", async () => {
    const response = await withEnv({ ADMIN_TOKEN }, () => gmGet(RESULTS));
    expect(response.status).toBe(200);
    const body = debriefResultsSchema.parse(await response.json());
    expect(body.eventNo).toBe(EVENT_NO);
    expect(body.goals).toEqual([
      { teamName: "一班", goalAtUtc: goalTimes.get("710001") },
      { teamName: "三班", goalAtUtc: goalTimes.get("710003") },
      { teamName: "五班", goalAtUtc: goalTimes.get("710005") },
    ]);
    // 監査賞は受賞チーム（所要が最短のチーム）だけ。
    expect(body.audit).toEqual([{ teamName: "五班", s3Min: 0.4 }]);
    expect(JSON.stringify(body)).not.toContain("7100");
  });

  it("申し送り: リセット後の一言だけ。個人情報を書いた一言は本文が空で返る", async () => {
    const response = await withEnv({ ADMIN_TOKEN }, () => gmGet(HANDOVER));
    expect(response.status).toBe(200);
    const body = debriefHandoverSchema.parse(await response.json());
    expect(body.handovers).toEqual([
      { teamName: "一班", text: "マニュアルは原本を開け" },
      { teamName: "五班", text: "" },
    ]);
    expect(JSON.stringify(body)).not.toContain(PII_SURNAME);
    expect(JSON.stringify(body)).not.toContain("リセット前の一言");
  });

  it("開催回はWorkerのEVENT_NOで決まる（別の回の行はその回でだけ出る）", async () => {
    const response = await withEnv({ ADMIN_TOKEN, EVENT_NO: "72" }, () => gmGet(RESULTS));
    const body = debriefResultsSchema.parse(await response.json());
    expect(body.eventNo).toBe("72");
    expect(body.goals).toEqual([{ teamName: "別の回", goalAtUtc: "2026-10-31 00:00:00.000" }]);
    expect(body.audit).toEqual([]);
  });

  it.each([
    ["トークンなし", null],
    ["違うトークン", "wrong-token"],
  ])("%sはGM系と同じ404で、集計を返さない", async (_label, token) => {
    for (const path of [RESULTS, HANDOVER]) {
      const response = await withEnv({ ADMIN_TOKEN }, () => gmGet(path, token));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("ADMIN_TOKENが未設定なら、何を送っても404（fail-closed）", async () => {
    for (const token of [ADMIN_TOKEN, ""]) {
      const response = await withEnv({ ADMIN_TOKEN: undefined }, () => gmGet(RESULTS, token));
      expect(response.status).toBe(404);
    }
  });

  it("GM系の未知のパスも、トークンを通っていても404", async () => {
    const response = await withEnv({ ADMIN_TOKEN }, () => gmGet("/api/gm/debrief/unknown"));
    expect(response.status).toBe(404);
  });

  it.each([
    ["未設定", undefined],
    ["2桁数字でない", "7"],
  ])("EVENT_NOが%sなら、集計せず理由を示すエラーを返す", async (_label, eventNo) => {
    const response = await withEnv({ ADMIN_TOKEN, EVENT_NO: eventNo }, () => gmGet(HANDOVER));
    expect(response.status).toBe(500);
    const body = z.object({ message: z.string() }).parse(await response.json());
    expect(body.message).toContain("EVENT_NO");
  });

  it("成功・404・500のどの応答も Cache-Control: no-store（途中で集計や拒否が残らない）", async () => {
    const responses = [
      await withEnv({ ADMIN_TOKEN }, () => gmGet(RESULTS)),
      await withEnv({ ADMIN_TOKEN }, () => gmGet(HANDOVER)),
      await withEnv({ ADMIN_TOKEN }, () => gmGet(RESULTS, null)),
      await withEnv({ ADMIN_TOKEN }, () => gmGet("/api/gm/debrief/unknown")),
      await withEnv({ ADMIN_TOKEN, EVENT_NO: undefined }, () => gmGet(HANDOVER)),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 404, 404, 500]);
    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("別オリジンからは、トークンがあっても入口ガードで403", async () => {
    const response = await withEnv({ ADMIN_TOKEN }, () =>
      exports.default.fetch(
        new Request(`${TEST_ORIGIN}${RESULTS}`, {
          headers: { Origin: "https://evil.test", Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      ),
    );
    expect(response.status).toBe(403);
  });

  it("進捗ボードのGET（トークン不要）はこの追加で変わらない", async () => {
    expect((await get("/api/progress/summary")).status).toBe(200);
  });
});
