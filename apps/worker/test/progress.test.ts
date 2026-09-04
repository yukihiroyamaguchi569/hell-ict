import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { publicTeamId } from "@hell-ict/domain";
import { z } from "zod";

import { progressSchemaSql } from "../src/progress.js";
import { get, postJson, TEST_ORIGIN } from "./support.js";

// サマリーは生のチームコードを返さない。publicId（SHA-256の先頭8桁）と、
// ?teamCode= で指定した自分の行だけに付くisSelfで構成される。
const summarySchema = z.object({
  teams: z.array(
    z.object({
      publicId: z.string().regex(/^[0-9a-f]{8}$/),
      isSelf: z.literal(true).optional(),
      teamName: z.string(),
      pos: z.number(),
      updatedAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      publicId: z.string().regex(/^[0-9a-f]{8}$/),
      isSelf: z.literal(true).optional(),
      teamName: z.string(),
      pos: z.number(),
      view: z.string(),
      kind: z.string(),
      createdAt: z.string(),
    }),
  ),
});

type Summary = z.infer<typeof summarySchema>;

/** 期待値を組むための公開ID。実装と同じ導出（SHA-256の先頭8桁）を使う。 */
const idOf = (teamCode: string): Promise<string> => publicTeamId(teamCode);

const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  teamCode: "100001",
  teamName: "感染対策室",
  pos: 1,
  view: "s1",
  kind: "clear",
  clientAt: "2026-08-23T02:00:00.000Z",
  ...overrides,
});

const summary = async (query = ""): Promise<Summary> => {
  const response = await get(`/api/progress/summary${query}`);
  expect(response.status).toBe(200);
  return summarySchema.parse(await response.json());
};

/** JSONとして壊れた本文や本文なしを送るため、support.tsのpostJsonを経由しない。 */
const postRaw = async (body: BodyInit | null): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}/api/progress`, {
      method: "POST",
      body,
      headers: { Origin: TEST_ORIGIN },
    }),
  );

const rowCount = async (): Promise<number> => {
  const row = await env.PROGRESS_DB.prepare("SELECT COUNT(*) AS n FROM progress_events").first("n");
  return z.number().parse(row);
};

const DROP_TABLE = "DROP TABLE IF EXISTS progress_events;";

// このpoolではD1の中身がテスト間で巻き戻らない（KVやDOと違い持ち越される）ため、
// 各テストの冒頭でテーブルごと作り直して白紙から始める。
//
// ensureSchemaの初期化状態はモジュールスコープのPromiseで、テストファイル内で
// 持ち越される。「まだ一度も初期化していない」状態を踏めるのはファイル先頭の
// このテストだけなので、コールドスタート関連はここへ集約する。
// スキーマは流さずDROPだけして、Worker自身にテーブルを作らせる。
describe("進捗記録: スキーマ未適用のD1", () => {
  it("マイグレーション未適用でも、同時に届いた複数リクエストを取りこぼさない", async () => {
    await env.PROGRESS_DB.exec(DROP_TABLE);

    // 初期化が1回きりのフラグ方式だと、2本目がテーブル作成の完了を待たずに
    // INSERTへ進んで503になる。共有Promiseを待つので両方とも200になる。
    const responses = await Promise.all([
      postJson("/api/progress", event({ pos: 1, view: "s1" })),
      postJson("/api/progress", event({ teamCode: "100002", teamName: "第二班", pos: 3 })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(responses[0]?.json()).resolves.toEqual({ ok: true });
    expect((await summary()).teams).toMatchObject([
      { publicId: await idOf("100002"), pos: 3 },
      { publicId: await idOf("100001"), pos: 1 },
    ]);
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
    expect(result.teams).toMatchObject([
      { publicId: await idOf("100001"), teamName: "感染対策室", pos: 2 },
    ]);
    expect(result.teams[0]?.updatedAt).not.toBe("");
    expect(result.events).toMatchObject([
      { publicId: await idOf("100001"), pos: 2, view: "s2", kind: "clear" },
    ]);
  });

  it("jumpはposへ算入しないが、最終更新時刻とeventsには残す", async () => {
    await postJson("/api/progress", event({ pos: 2, kind: "clear", view: "s2" }));
    await postJson("/api/progress", event({ pos: 5, kind: "jump", view: "s5" }));

    const result = await summary();
    expect(result.teams).toMatchObject([{ publicId: await idOf("100001"), pos: 2 }]);
    expect(result.events[0]).toMatchObject({ kind: "jump", pos: 5 });
    expect(result.events).toHaveLength(2);
  });

  it("非jumpが1件も無いチームはpos 0として扱う", async () => {
    await postJson("/api/progress", event({ pos: 6, kind: "jump" }));
    expect((await summary()).teams).toMatchObject([{ publicId: await idOf("100001"), pos: 0 }]);
  });

  it("resumeは200で記録するが、jumpと同じくposへ算入しない", async () => {
    await postJson("/api/progress", event({ pos: 2, kind: "clear", view: "s2" }));
    const response = await postJson("/api/progress", event({ pos: 5, kind: "resume", view: "s5" }));

    expect(response.status).toBe(200);
    const result = await summary();
    expect(result.teams).toMatchObject([{ publicId: await idOf("100001"), pos: 2 }]);
    expect(result.events[0]).toMatchObject({ kind: "resume", pos: 5 });
    expect(result.events).toHaveLength(2);
  });

  it("resumeしか無いチームはpos 0として扱う", async () => {
    await postJson("/api/progress", event({ pos: 6, kind: "resume" }));
    expect((await summary()).teams).toMatchObject([{ publicId: await idOf("100001"), pos: 0 }]);
  });

  it("posは最大値を採る（戻る操作で後退させない）", async () => {
    await postJson("/api/progress", event({ pos: 4, kind: "clear" }));
    await postJson("/api/progress", event({ pos: 1, kind: "entry" }));
    expect((await summary()).teams).toMatchObject([{ publicId: await idOf("100001"), pos: 4 }]);
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

  it("TEAM_CODES設定時、未登録チームの進捗は404で拒否しD1へ書かない", async () => {
    const saved = env.TEAM_CODES;
    env.TEAM_CODES = "100001,100002";
    try {
      const rejected = await postJson("/api/progress", event({ teamCode: "100009" }));
      expect(rejected.status).toBe(404);
      await expect(rowCount()).resolves.toBe(0);

      const accepted = await postJson("/api/progress", event({ teamCode: "100001" }));
      expect(accepted.status).toBe(200);
      await expect(rowCount()).resolves.toBe(1);
    } finally {
      env.TEAM_CODES = saved;
    }
  });

  it("TEAM_CODES未設定なら任意の6桁の進捗を受け付ける", async () => {
    const response = await postJson("/api/progress", event({ teamCode: "987654" }));
    expect(response.status).toBe(200);
    await expect(rowCount()).resolves.toBe(1);
  });

  it("JSONとして壊れた本文と空bodyは400で拒否し、行を増やさない", async () => {
    expect((await postRaw("{not json")).status).toBe(400);
    expect((await postRaw("")).status).toBe(400);
    expect((await postRaw(null)).status).toBe(400);
    await expect(rowCount()).resolves.toBe(0);
  });

  it("TEAM_CODES設定時、summaryは許可コードの行だけを返す", async () => {
    const insert = env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at, created_at)
       VALUES (?, ?, ?, '', 'clear', '', ?)`,
    );
    await env.PROGRESS_DB.batch([
      insert.bind("100001", "許可A", 3, "2026-08-23 01:00:00"),
      insert.bind("100002", "許可B", 5, "2026-08-23 01:00:01"),
      insert.bind("999999", "未登録", 7, "2026-08-23 01:00:02"),
    ]);

    const saved = env.TEAM_CODES;
    try {
      env.TEAM_CODES = "100001,100002";
      const filtered = await summary();
      expect(filtered.teams.map((team) => team.publicId)).toEqual([
        await idOf("100002"),
        await idOf("100001"),
      ]);
      expect(filtered.events.map((event) => event.publicId)).not.toContain(await idOf("999999"));
      expect(filtered.events).toHaveLength(2);
    } finally {
      env.TEAM_CODES = saved;
    }

    // 未設定なら従来どおり全件。
    const all = await summary();
    expect(all.teams.map((team) => team.publicId)).toEqual([
      await idOf("999999"),
      await idOf("100002"),
      await idOf("100001"),
    ]);
    expect(all.events).toHaveLength(3);
  });

  it("未許可チームのイベントが多くても、許可チームの最新イベントは埋もれない", async () => {
    // 絞り込みがLIMIT 20の後だと、未登録チームの25件が枠を食い潰して許可チームの
    // イベントがダッシュボードから消える。「絞ってからLIMIT」であることを固定する。
    const insert = env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at)
       VALUES (?, ?, 1, ?, 'clear', '')`,
    );
    await env.PROGRESS_DB.batch([
      insert.bind("100001", "許可", "allowed-old"),
      ...Array.from({ length: 25 }, (_unused, index) =>
        insert.bind("999999", "未登録", `noise${String(index)}`),
      ),
    ]);

    const saved = env.TEAM_CODES;
    try {
      env.TEAM_CODES = "100001";
      const result = await summary();
      expect(result.events.map((event) => event.view)).toEqual(["allowed-old"]);
      expect(result.teams.map((team) => team.publicId)).toEqual([await idOf("100001")]);
    } finally {
      env.TEAM_CODES = saved;
    }

    // 未設定なら従来どおり全チームから最新20件。
    const all = await summary();
    expect(all.events).toHaveLength(20);
    const noiseId = await idOf("999999");
    expect(all.events.every((event) => event.publicId === noiseId)).toBe(true);
  });

  it("応答に生の6桁チームコードが含まれない", async () => {
    // サマリーは参加者の端末からも読める。生のコードが見えると、そのまま入室に使えてしまう。
    await postJson("/api/progress", event({ teamCode: "100001", teamName: "感染対策室" }));
    await postJson("/api/progress", event({ teamCode: "100002", teamName: "第二班" }));

    const response = await get("/api/progress/summary");
    const body = await response.text();
    expect(body).not.toContain("100001");
    expect(body).not.toContain("100002");
    expect(body).toContain(await idOf("100001"));
  });

  it("?teamCodeを付けると自分の行だけisSelfが立つ", async () => {
    await postJson("/api/progress", event({ teamCode: "100001", teamName: "自分" }));
    await postJson("/api/progress", event({ teamCode: "100002", teamName: "他所" }));

    const result = await summary("?teamCode=100001");
    const selfId = await idOf("100001");
    const selfRows = result.teams.filter((team) => team.isSelf === true);
    expect(selfRows.map((team) => team.publicId)).toEqual([selfId]);
    expect(result.teams.filter((team) => team.publicId !== selfId)).toSatisfy(
      (rows: { isSelf?: true }[]) => rows.every((row) => row.isSelf === undefined),
    );
    expect(result.events.filter((e) => e.isSelf === true).map((e) => e.publicId)).toEqual([selfId]);
  });

  it("許可リストに無いコードを?teamCodeに付けてもisSelfは立たない", async () => {
    await postJson("/api/progress", event({ teamCode: "100001", teamName: "自分" }));

    const saved = env.TEAM_CODES;
    try {
      env.TEAM_CODES = "100001";
      // 未登録のコードで他チームの行へisSelfを立てさせない。
      const result = await summary("?teamCode=999999");
      expect(result.teams.some((team) => team.isSelf === true)).toBe(false);
      expect(result.events.some((e) => e.isSelf === true)).toBe(false);
    } finally {
      env.TEAM_CODES = saved;
    }
  });

  it("?teamCodeを付けなければisSelfは付かない", async () => {
    await postJson("/api/progress", event({ teamCode: "100001" }));
    const result = await summary();
    expect(result.teams.some((team) => team.isSelf === true)).toBe(false);
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
    expect(result.teams.map((team) => team.publicId)).toEqual([
      await idOf("100002"),
      await idOf("100003"),
      await idOf("100001"),
    ]);
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
