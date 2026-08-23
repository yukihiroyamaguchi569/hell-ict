import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { progressSchemaSql } from "../src/progress.js";
import { postJson } from "./support.js";

const summarySchema = z.object({
  teams: z.array(
    z.object({
      teamCode: z.string(),
      teamName: z.string(),
      pos: z.number(),
      updatedAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      teamCode: z.string(),
      teamName: z.string(),
      pos: z.number(),
      view: z.string(),
      kind: z.string(),
      createdAt: z.string(),
    }),
  ),
});

type Summary = z.infer<typeof summarySchema>;

const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  teamCode: "100001",
  teamName: "感染対策室",
  pos: 1,
  view: "s1",
  kind: "clear",
  clientAt: "2026-08-23T02:00:00.000Z",
  ...overrides,
});

const summary = async (): Promise<Summary> => {
  const response = await exports.default.fetch(
    new Request("https://example.test/api/progress/summary"),
  );
  expect(response.status).toBe(200);
  return summarySchema.parse(await response.json());
};

/** JSONとして壊れた本文や本文なしを送るため、support.tsのpostJsonを経由しない。 */
const postRaw = async (body: BodyInit | null): Promise<Response> =>
  exports.default.fetch(new Request("https://example.test/api/progress", { method: "POST", body }));

const rowCount = async (): Promise<number> => {
  const row = await env.PROGRESS_DB.prepare("SELECT COUNT(*) AS n FROM progress_events").first("n");
  return z.number().parse(row);
};

const DROP_TABLE = "DROP TABLE IF EXISTS progress_events;";

// このpoolではD1の中身がテスト間で巻き戻らない（KVやDOと違い持ち越される）ため、
// 各テストの冒頭でテーブルごと作り直して白紙から始める。
// 1本目だけは、テーブルが無い状態からWorker自身のensureSchemaが作る経路を通すので、
// スキーマを流さずにDROPだけしておく。
describe("進捗記録: スキーマ未適用のD1", () => {
  it("マイグレーション未適用でもWorkerがテーブルを作って記録する", async () => {
    await env.PROGRESS_DB.exec(DROP_TABLE);

    const response = await postJson("/api/progress", event());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect((await summary()).teams).toMatchObject([{ teamCode: "100001", pos: 1 }]);
  });
});

describe("進捗記録", () => {
  beforeEach(async () => {
    await env.PROGRESS_DB.exec(DROP_TABLE);
    await env.PROGRESS_DB.exec(progressSchemaSql);
  });

  it("イベントが1件も無いときteamsとeventsは空配列を返す", async () => {
    await expect(summary()).resolves.toEqual({ teams: [], events: [] });
  });

  it("POSTした進捗がteamsとeventsの両方へ反映される", async () => {
    expect((await postJson("/api/progress", event({ pos: 2, view: "s2" }))).status).toBe(200);

    const result = await summary();
    expect(result.teams).toMatchObject([{ teamCode: "100001", teamName: "感染対策室", pos: 2 }]);
    expect(result.teams[0]?.updatedAt).not.toBe("");
    expect(result.events).toMatchObject([
      { teamCode: "100001", pos: 2, view: "s2", kind: "clear" },
    ]);
  });

  it("jumpはposへ算入しないが、最終更新時刻とeventsには残す", async () => {
    await postJson("/api/progress", event({ pos: 2, kind: "clear", view: "s2" }));
    await postJson("/api/progress", event({ pos: 5, kind: "jump", view: "s5" }));

    const result = await summary();
    expect(result.teams).toMatchObject([{ teamCode: "100001", pos: 2 }]);
    expect(result.events[0]).toMatchObject({ kind: "jump", pos: 5 });
    expect(result.events).toHaveLength(2);
  });

  it("非jumpが1件も無いチームはpos 0として扱う", async () => {
    await postJson("/api/progress", event({ pos: 6, kind: "jump" }));
    expect((await summary()).teams).toMatchObject([{ teamCode: "100001", pos: 0 }]);
  });

  it("posは最大値を採る（戻る操作で後退させない）", async () => {
    await postJson("/api/progress", event({ pos: 4, kind: "clear" }));
    await postJson("/api/progress", event({ pos: 1, kind: "entry" }));
    expect((await summary()).teams).toMatchObject([{ teamCode: "100001", pos: 4 }]);
  });

  it("teamNameは最新の非空の値を採る", async () => {
    await postJson("/api/progress", event({ teamName: "第一波", pos: 1 }));
    await postJson("/api/progress", event({ teamName: "", pos: 2 }));
    expect((await summary()).teams).toMatchObject([{ teamName: "第一波", pos: 2 }]);
  });

  it("表示用の文字列は拒否せず規定長へ切り詰める", async () => {
    const response = await postJson(
      "/api/progress",
      event({ teamName: "あ".repeat(50), view: "v".repeat(60), clientAt: "c".repeat(80) }),
    );
    expect(response.status).toBe(200);

    const result = await summary();
    expect(result.teams[0]?.teamName).toHaveLength(24);
    expect(result.events[0]?.view).toHaveLength(32);
    const clientAt = await env.PROGRESS_DB.prepare(
      "SELECT client_at FROM progress_events LIMIT 1",
    ).first("client_at");
    expect(z.string().parse(clientAt)).toHaveLength(40);
  });

  it.each([
    ["kindが列挙外", event({ kind: "warp" })],
    ["kindが欠落", { teamCode: "100001", teamName: "", pos: 1, view: "", clientAt: "" }],
    ["posが上限超過", event({ pos: 8 })],
    ["posが負", event({ pos: -1 })],
    ["posが小数", event({ pos: 1.5 })],
    ["posが文字列", event({ pos: "3" })],
    ["teamCodeが5桁", event({ teamCode: "10001" })],
    ["teamCodeが全角", event({ teamCode: "１２３４５６" })],
    ["teamCodeが英字混じり", event({ teamCode: "10000a" })],
    ["bodyが配列", []],
    ["bodyがnull", null],
  ])("不正な入力(%s)は400で拒否し、行を増やさない", async (_label, body) => {
    const response = await postJson("/api/progress", body);
    expect(response.status).toBe(400);
    await expect(rowCount()).resolves.toBe(0);
  });

  it("JSONとして壊れた本文と空bodyは400で拒否し、行を増やさない", async () => {
    expect((await postRaw("{not json")).status).toBe(400);
    expect((await postRaw("")).status).toBe(400);
    expect((await postRaw(null)).status).toBe(400);
    await expect(rowCount()).resolves.toBe(0);
  });

  it("teamsはpos降順、同順位は最終更新が古い順に並ぶ", async () => {
    const insert = env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at, created_at)
       VALUES (?, ?, ?, '', 'clear', '', ?)`,
    );
    await env.PROGRESS_DB.batch([
      insert.bind("100001", "先行", 3, "2026-08-23 01:00:00"),
      insert.bind("100002", "同着先着", 5, "2026-08-23 01:00:01"),
      insert.bind("100003", "同着後着", 5, "2026-08-23 01:00:05"),
    ]);

    const result = await summary();
    expect(result.teams.map((team) => team.teamCode)).toEqual(["100002", "100003", "100001"]);
  });

  it("eventsは新しい順に最大20件まで返す", async () => {
    const insert = env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at)
       VALUES ('100001', 'ろぐ', 1, ?, 'entry', '')`,
    );
    await env.PROGRESS_DB.batch(
      Array.from({ length: 25 }, (_unused, index) => insert.bind(`v${String(index)}`)),
    );

    const result = await summary();
    expect(result.events).toHaveLength(20);
    expect(result.events[0]?.view).toBe("v24");
    expect(result.events[19]?.view).toBe("v5");
  });
});
