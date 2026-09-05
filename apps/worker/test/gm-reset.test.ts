import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { publicTeamId } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { activitySchemaSql } from "../src/activity-log.js";
import { progressSchemaSql } from "../src/progress.js";
import { get, postJson, session, TEST_ORIGIN } from "./support.js";

const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

/**
 * `env`の運用値を一時的に差し替える。テストのためだけの分岐を本番コードへ入れず、
 * 「未設定なら閉じる」というパーサの挙動をそのまま検証するための土台
 * （guard.test.tsのwithEnvと同じ流儀）。
 */
const withEnv = async <T>(
  overrides: Partial<Pick<Env, "ADMIN_TOKEN" | "EVENT_NO" | "TEAM_MAX">>,
  run: () => Promise<T>,
): Promise<T> => {
  const saved = { ADMIN_TOKEN: env.ADMIN_TOKEN, EVENT_NO: env.EVENT_NO, TEAM_MAX: env.TEAM_MAX };
  Object.assign(env, overrides);
  try {
    return await run();
  } finally {
    Object.assign(env, saved);
  }
};

const gmReset = async (path: string, token: string | null): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      headers:
        token === null
          ? { Origin: TEST_ORIGIN }
          : { Origin: TEST_ORIGIN, Authorization: `Bearer ${token}` },
    }),
  );

const resetByCode = (teamCode: string, token: string | null = ADMIN_TOKEN): Promise<Response> =>
  gmReset(`/api/gm/teams/${teamCode}/reset`, token);

const resetByPublicId = (publicId: string, token: string | null = ADMIN_TOKEN): Promise<Response> =>
  gmReset(`/api/gm/teams/by-public-id/${publicId}/reset`, token);

/** 入室応答のリセット世代。クライアントはこれを保持して以後の書き込みへ添える。 */
const joinGeneration = async (teamCode: string): Promise<number> => {
  const response = await session(teamCode);
  expect(response.status).toBe(200);
  return z.object({ generation: z.number() }).parse(await response.json()).generation;
};

const progressEvent = (teamCode: string, overrides: Record<string, unknown> = {}): unknown => ({
  teamCode,
  teamName: "感染対策室",
  pos: 3,
  view: "s3",
  kind: "clear",
  clientAt: "2026-09-06T02:00:00.000Z",
  ...overrides,
});

const summarySchema = z.object({
  teams: z.array(
    z.object({
      publicId: z.string(),
      teamName: z.string(),
      pos: z.number(),
      updatedAt: z.string(),
    }),
  ),
  events: z.array(z.object({ publicId: z.string(), kind: z.string(), pos: z.number() })),
});

const summary = async (): Promise<z.infer<typeof summarySchema>> => {
  const response = await get("/api/progress/summary");
  expect(response.status).toBe(200);
  return summarySchema.parse(await response.json());
};

const posOf = async (teamCode: string): Promise<number | null> => {
  const publicId = await publicTeamId(teamCode);
  return (await summary()).teams.find((team) => team.publicId === publicId)?.pos ?? null;
};

const activityKinds = async (teamCode: string): Promise<string[]> => {
  const rows = await env.PROGRESS_DB.prepare(
    "SELECT kind FROM activity_events WHERE team_code = ? ORDER BY id",
  )
    .bind(teamCode)
    .all();
  return z
    .array(z.object({ kind: z.string() }))
    .parse(rows.results)
    .map((row) => row.kind);
};

const progressKinds = async (teamCode: string): Promise<string[]> => {
  const rows = await env.PROGRESS_DB.prepare(
    "SELECT kind FROM progress_events WHERE team_code = ? ORDER BY id",
  )
    .bind(teamCode)
    .all();
  return z
    .array(z.object({ kind: z.string() }))
    .parse(rows.results)
    .map((row) => row.kind);
};

const saveCheckpoint = (
  teamCode: string,
  commandId: string,
  options: { expectedRevision?: number; generation?: number; flush?: boolean } = {},
): Promise<Response> =>
  postJson(`/api/teams/${teamCode}/checkpoint`, {
    type: "save-checkpoint",
    commandId,
    expectedRevision: options.expectedRevision ?? 0,
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.flush === undefined ? {} : { flush: options.flush }),
    body: {
      view: "s3",
      pos: 3,
      elapsedMs: 60_000,
      trap: { s3Used: false, s4Used: false },
      dataRevision: 0,
      data: { note: "途中経過" },
    },
  });

const checkpointOf = async (teamCode: string): Promise<unknown> => {
  const response = await get(`/api/teams/${teamCode}/checkpoint`);
  expect(response.status).toBe(200);
  return z.object({ checkpoint: z.unknown() }).parse(await response.json()).checkpoint;
};

// D1はこのpoolでテスト間に巻き戻らないため、白紙から始められるよう毎回作り直す。
// migrationsも落とす（完了印が残ると一度きりの移行が走らない）。
const RESET_D1 = [
  "DROP TABLE IF EXISTS progress_events;",
  "DROP TABLE IF EXISTS activity_events;",
  "DROP TABLE IF EXISTS migrations;",
].join("\n");

beforeEach(async () => {
  await env.PROGRESS_DB.exec(RESET_D1);
  await env.PROGRESS_DB.exec(progressSchemaSql);
  await env.PROGRESS_DB.exec(activitySchemaSql);
});

describe("GMリセット: 認証", () => {
  it("ADMIN_TOKEN未設定なら、正しそうなトークンを付けても404でDOを1つも作らない", async () => {
    await withEnv({ ADMIN_TOKEN: undefined }, async () => {
      const before = await listDurableObjectIds(env.TEAM_ROOM);
      const response = await resetByCode("300001");
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not found");
      await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toHaveLength(before.length);
    });
  });

  it("空文字のADMIN_TOKENは未設定と同じく閉じる（空のBearerでも通らない）", async () => {
    await withEnv({ ADMIN_TOKEN: "" }, async () => {
      expect((await resetByCode("300002", "")).status).toBe(404);
    });
  });

  it("トークン無し・不一致・Bearer以外の形式はすべて404", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      expect((await resetByCode("300003", null)).status).toBe(404);
      expect((await resetByCode("300003", "wrong-token")).status).toBe(404);
      // 長さだけ合っていて中身が違うトークン。
      expect((await resetByCode("300003", `${ADMIN_TOKEN.slice(0, -1)}X`)).status).toBe(404);
      const raw = await exports.default.fetch(
        new Request(`${TEST_ORIGIN}/api/gm/teams/300003/reset`, {
          method: "POST",
          headers: { Origin: TEST_ORIGIN, Authorization: ADMIN_TOKEN },
        }),
      );
      expect(raw.status).toBe(404);
    });
  });

  it("トークン不一致では、進捗も活動ログも1行も増えない", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      await session("300004");
      await postJson("/api/progress", progressEvent("300004"));
      expect((await resetByCode("300004", "wrong-token")).status).toBe(404);
      await expect(progressKinds("300004")).resolves.toEqual(["clear"]);
      await expect(activityKinds("300004")).resolves.toEqual([]);
    });
  });

  it("許可されていないOriginは、正しいトークンでも403で止まる", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const response = await exports.default.fetch(
        new Request(`${TEST_ORIGIN}/api/gm/teams/300005/reset`, {
          method: "POST",
          headers: { Origin: "https://evil.test", Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  it("GM配下の未知のパスも404に揃える", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      expect((await gmReset("/api/gm/teams/300006/purge", ADMIN_TOKEN)).status).toBe(404);
      expect((await gmReset("/api/gm/anything", ADMIN_TOKEN)).status).toBe(404);
    });
  });
});

describe("GMリセット: 規則判定", () => {
  it("規則から外れたコードは、正しいトークンでも404", async () => {
    await withEnv({ ADMIN_TOKEN, EVENT_NO: "02", TEAM_MAX: "10" }, async () => {
      // 上2桁が違う／チーム番号が上限超過／6桁でない。
      expect((await resetByCode("030001")).status).toBe(404);
      expect((await resetByCode("020011")).status).toBe(404);
      expect((await resetByCode("02001")).status).toBe(404);
    });
  });

  it("規則内のコードは通り、進捗にresetが1行残る", async () => {
    await withEnv({ ADMIN_TOKEN, EVENT_NO: "02", TEAM_MAX: "10" }, async () => {
      await session("020003");
      const response = await resetByCode("020003");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await expect(progressKinds("020003")).resolves.toEqual(["reset"]);
    });
  });
});

describe("GMリセット: リセットの中身", () => {
  it("チェックポイント・会話・冪等台帳・帯を初期へ戻し、活動ログの過去行は残す", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "310001";
      await session(teamCode);
      await postJson("/api/progress", progressEvent(teamCode));
      await postJson(`/api/teams/${teamCode}/activity`, {
        commandId: "00000000-0000-4000-8000-000000000101",
        kind: "submit.s3",
        view: "s3",
        text: "提出しました",
        clientAt: "2026-09-06T02:01:00.000Z",
      });
      expect((await saveCheckpoint(teamCode, "00000000-0000-4000-8000-000000000102")).status).toBe(
        200,
      );
      expect(await checkpointOf(teamCode)).not.toBeNull();
      await expect(posOf(teamCode)).resolves.toBe(3);

      const response = await resetByCode(teamCode);
      expect(response.status).toBe(200);

      // チェックポイントは空、チャットはスレッド無しの初期状態へ戻る。
      expect(await checkpointOf(teamCode)).toBeNull();
      // チャットは作り直された初期スナップショット（メイン1本・発言0件・revision 0）。
      const chat = await get(`/api/teams/${teamCode}/chat`);
      await expect(chat.json()).resolves.toMatchObject({
        teamCode,
        revision: 0,
        threads: [{ title: "メイン", messages: [] }],
      });

      // 活動ログの過去行は残り、gm.resetが1件増える。
      await expect(activityKinds(teamCode)).resolves.toEqual(["submit.s3", "gm.reset"]);
      const meta = await env.PROGRESS_DB.prepare(
        "SELECT meta, text FROM activity_events WHERE team_code = ? AND kind = 'gm.reset'",
      )
        .bind(teamCode)
        .first();
      expect(meta).toEqual({ meta: '{"by":"gm"}', text: "" });

      // 進捗イベントの過去行も残り、サマリーの位置だけが初期へ戻る。
      await expect(progressKinds(teamCode)).resolves.toEqual(["clear", "reset"]);
      await expect(posOf(teamCode)).resolves.toBe(0);
    });
  });

  it("同じcommandIdでもう一度チェックポイントを保存できる（台帳が空でも動く）", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "310002";
      const commandId = "00000000-0000-4000-8000-000000000201";
      await session(teamCode);
      expect((await saveCheckpoint(teamCode, commandId)).status).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);

      // 台帳が空なので、同じcommandIdの保存が「適用済み」扱いにならず新規で通る
      // （リセットで世代が1つ進むので、入り直した端末の世代を添える）。
      expect((await saveCheckpoint(teamCode, commandId, { generation: 1 })).status).toBe(200);
      expect(await checkpointOf(teamCode)).toMatchObject({ revision: 1, body: { pos: 3 } });
    });
  });

  it("リセット後も同じコードで入室でき、初期状態から始まる", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "310003";
      await session(teamCode);
      const commandId = "00000000-0000-4000-8000-000000000301";
      expect(
        (
          await postJson(`/api/teams/${teamCode}/commands`, {
            type: "enter-stage1",
            commandId,
            expectedRevision: 0,
          })
        ).status,
      ).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);

      const rejoined = await session(teamCode);
      expect(rejoined.status).toBe(200);
      await expect(rejoined.json()).resolves.toMatchObject({
        teamCode,
        revision: 0,
        state: { stage: "prologue" },
      });
      // 冪等台帳も空なので、同じcommandIdの操作がもう一度適用できる。
      const replayed = await postJson(`/api/teams/${teamCode}/commands`, {
        type: "enter-stage1",
        commandId,
        expectedRevision: 0,
      });
      expect(replayed.status).toBe(200);
    });
  });

  it("リセットは冪等で、2回押しても壊れない", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "310004";
      await session(teamCode);
      expect((await resetByCode(teamCode)).status).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);
      await expect(progressKinds(teamCode)).resolves.toEqual(["reset", "reset"]);
      await expect(posOf(teamCode)).resolves.toBe(0);
    });
  });

  it("リセット後に進んだ分は、また位置として数える", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "310005";
      await session(teamCode);
      await postJson("/api/progress", progressEvent(teamCode));
      expect((await resetByCode(teamCode)).status).toBe(200);
      await postJson(
        "/api/progress",
        progressEvent(teamCode, { pos: 1, view: "s1", generation: 1 }),
      );
      await expect(posOf(teamCode)).resolves.toBe(1);
    });
  });

  it("クライアントからkind=resetは送れない（自分の位置を戻せない）", async () => {
    const response = await postJson("/api/progress", progressEvent("310006", { kind: "reset" }));
    expect(response.status).toBe(400);
    await expect(progressKinds("310006")).resolves.toEqual([]);
  });
});

describe("GMリセット: publicId版", () => {
  it("サマリーのpublicIdで対象を特定してリセットできる", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "320001";
      await session(teamCode);
      await postJson("/api/progress", progressEvent(teamCode));
      const publicId = (await summary()).teams[0]?.publicId ?? "";
      expect(publicId).toBe(await publicTeamId(teamCode));

      const response = await resetByPublicId(publicId);
      expect(response.status).toBe(200);
      await expect(posOf(teamCode)).resolves.toBe(0);
      await expect(activityKinds(teamCode)).resolves.toEqual(["gm.reset"]);
    });
  });

  it("存在しないpublicIdと、形式が違うpublicIdは404", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      expect((await resetByPublicId("deadbeef")).status).toBe(404);
      expect((await resetByPublicId("DEADBEEF")).status).toBe(404);
      expect((await resetByPublicId("dead")).status).toBe(404);
    });
  });

  it("規則から外れたチームのpublicIdは、引けても404で止まる", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      await postJson("/api/progress", progressEvent("320002"));
      const publicId = await publicTeamId("320002");
      await withEnv({ EVENT_NO: "02", TEAM_MAX: "10" }, async () => {
        expect((await resetByPublicId(publicId)).status).toBe(404);
      });
      await expect(progressKinds("320002")).resolves.toEqual(["clear"]);
    });
  });
});

describe("GMリセット: リセット世代", () => {
  it("入室応答に世代が載り、リセットのたびに1つ進む", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330001";
      await expect(joinGeneration(teamCode)).resolves.toBe(0);
      expect((await resetByCode(teamCode)).status).toBe(200);
      await expect(joinGeneration(teamCode)).resolves.toBe(1);
      expect((await resetByCode(teamCode)).status).toBe(200);
      await expect(joinGeneration(teamCode)).resolves.toBe(2);
    });
  });

  it("リセット前の世代で送った進捗は409で拒否され、D1に1行も増えない", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330002";
      const generation = await joinGeneration(teamCode);
      await postJson("/api/progress", progressEvent(teamCode, { generation }));
      expect((await resetByCode(teamCode)).status).toBe(200);

      // リロードしていない古いタブからの、遅れて届いた位置イベント。
      const stale = await postJson("/api/progress", progressEvent(teamCode, { generation }));
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ code: "stale-generation" });
      await expect(progressKinds(teamCode)).resolves.toEqual(["clear", "reset"]);
      // 帯の位置も戻ったまま——これが復活するのが元の不具合だった。
      await expect(posOf(teamCode)).resolves.toBe(0);
    });
  });

  it("世代を省いた進捗は0として扱われ、リセット後は拒否される", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330003";
      // リセット前（世代0）は省略しても通る。古いクライアントとの後方互換。
      expect((await postJson("/api/progress", progressEvent(teamCode))).status).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);
      const stale = await postJson("/api/progress", progressEvent(teamCode));
      expect(stale.status).toBe(409);
      await expect(progressKinds(teamCode)).resolves.toEqual(["clear", "reset"]);
    });
  });

  it("リセット前の世代のチェックポイント保存は、通常もflushも409で何も書かない", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330004";
      const generation = await joinGeneration(teamCode);
      expect(
        (await saveCheckpoint(teamCode, "00000000-0000-4000-8000-000000000401", { generation }))
          .status,
      ).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);

      const stale = await saveCheckpoint(teamCode, "00000000-0000-4000-8000-000000000402", {
        generation,
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ code: "stale-generation" });

      // CASを外すflushも同じく弾く。ここを通すと、古いbodyが「初回保存」として蘇る。
      const staleFlush = await saveCheckpoint(teamCode, "00000000-0000-4000-8000-000000000403", {
        generation,
        flush: true,
      });
      expect(staleFlush.status).toBe(409);
      await expect(staleFlush.json()).resolves.toMatchObject({ code: "stale-generation" });

      // どちらもDurable Objectへ1行も書いていない。
      expect(await checkpointOf(teamCode)).toBeNull();
    });
  });

  it("リセット前の世代のcommandIdを再送しても、台帳の再生で状態が戻らない", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330005";
      const commandId = "00000000-0000-4000-8000-000000000501";
      const generation = await joinGeneration(teamCode);
      expect((await saveCheckpoint(teamCode, commandId, { generation })).status).toBe(200);
      expect((await resetByCode(teamCode)).status).toBe(200);
      expect((await saveCheckpoint(teamCode, commandId, { generation })).status).toBe(409);
      expect(await checkpointOf(teamCode)).toBeNull();
    });
  });

  it("入り直して新しい世代を使えば、進捗もチェックポイントも通る", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330006";
      await session(teamCode);
      expect((await resetByCode(teamCode)).status).toBe(200);

      const generation = await joinGeneration(teamCode);
      expect(generation).toBe(1);
      expect(
        (await postJson("/api/progress", progressEvent(teamCode, { pos: 2, generation }))).status,
      ).toBe(200);
      expect(
        (await saveCheckpoint(teamCode, "00000000-0000-4000-8000-000000000601", { generation }))
          .status,
      ).toBe(200);
      await expect(posOf(teamCode)).resolves.toBe(2);
      expect(await checkpointOf(teamCode)).not.toBeNull();
    });
  });

  it("先の世代を騙っても通らない（照合は一致のみ）", async () => {
    await withEnv({ ADMIN_TOKEN }, async () => {
      const teamCode = "330007";
      await session(teamCode);
      const ahead = await postJson("/api/progress", progressEvent(teamCode, { generation: 9 }));
      expect(ahead.status).toBe(409);
      await expect(progressKinds(teamCode)).resolves.toEqual([]);
    });
  });
});
