import { env, exports } from "cloudflare:workers";
import { createExecutionContext, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { chatSnapshotSchema, createThreadResultSchema, httpErrorSchema } from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { FakeAiOutcome } from "@hell-ict/domain/fakes";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  beginChatGateSchema,
  claimGenerationSchema,
  corsHeadersFor,
  DEFAULT_CHAT_RATE_LIMIT,
  isOriginAllowed,
  isOriginlessRequestAllowed,
  fingerprintSchema,
  isTeamCodeAllowed,
  MAX_CHAT_RATE_LIMIT,
  MIN_CHAT_RATE_LIMIT,
  nowMsSchema,
  parseAllowedOrigins,
  parseChatRateLimit,
  parseTeamCodes,
  RATE_LIMIT_WINDOW_MS,
  rateLimitBucket,
  rateLimitCountSchema,
  rateLimitRetryAfterSeconds,
} from "../src/guard.js";
import { handleChatMessage } from "../src/index.js";
import { MAX_MANUAL_THREADS_PER_TEAM, MAX_STAGE_THREADS_PER_TEAM } from "../src/team-room.js";
import { get, postJson, session, TEST_ORIGIN, upgrade } from "./support.js";

const OTHER_ORIGIN = "https://evil.test";

const fetchWithHeaders = (
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify({ teamCode: "500000" }) : undefined,
    }),
  );

/**
 * `env`の運用値を一時的に差し替える。テストのためだけの分岐を本番コードへ入れず、
 * 「未設定なら既定」というパーサの挙動をそのまま検証するための土台。
 */
const withEnv = async <T>(
  overrides: Partial<Pick<Env, "ALLOWED_ORIGINS" | "TEAM_CODES">>,
  run: () => Promise<T>,
): Promise<T> => {
  const saved = { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS, TEAM_CODES: env.TEAM_CODES };
  Object.assign(env, overrides);
  try {
    return await run();
  } finally {
    Object.assign(env, saved);
  }
};

/** 送信可能なスレッドを1つ用意し、そのthreadIdを返す。 */
const prepareThread = async (teamCode: string, commandId: string): Promise<string> => {
  await session(teamCode);
  const created = await postJson(`/api/teams/${teamCode}/chat/threads`, {
    type: "create-thread",
    commandId,
    title: "副",
  });
  const { snapshot } = createThreadResultSchema.parse(await created.json());
  const threadId = snapshot.threads[0]?.threadId;
  if (threadId === undefined) throw new Error("unexpected");
  return threadId;
};

const messageCommandId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const successOutcomes = (count: number): FakeAiOutcome[] =>
  Array.from({ length: count }, () => ({ kind: "success", response: "応答" }) as const);

const sendChat = (
  teamCode: string,
  body: { commandId: string; threadId: string; text: string },
  gateway: FakeAiGateway,
  nowMs: number,
): Promise<Response> =>
  handleChatMessage(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "send-message", ...body }),
    }),
    { env, ctx: createExecutionContext() },
    teamCode,
    { aiGateway: gateway, nowMs },
  );

/** レート制限の判定で書き換わりうる3つの記録をまとめて数える（原子性の確認用）。 */
const storageCountsOf = async (
  teamCode: string,
  nowMs: number,
): Promise<{ rateLimit: number; messages: number; pending: number }> => {
  const bucket = rateLimitBucket(nowMs, RATE_LIMIT_WINDOW_MS);
  const messages = await messageCountOf(teamCode);
  return runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
    const rateLimit = state.storage.sql
      .exec("SELECT count FROM rate_limit WHERE bucket = ?", bucket)
      .toArray();
    const pending = state.storage.sql
      .exec("SELECT command_id FROM pending_message_commands")
      .toArray();
    return {
      rateLimit: z.number().parse(rateLimit[0]?.count ?? 0),
      messages,
      pending: pending.length,
    };
  });
};

const messageCountOf = async (teamCode: string): Promise<number> => {
  const response = await get(`/api/teams/${teamCode}/chat`);
  const snapshot = chatSnapshotSchema.parse(await response.json());
  return snapshot.threads.reduce((total, thread) => total + thread.messages.length, 0);
};

describe("Origin判定（Pure Function）", () => {
  it("ALLOWED_ORIGINSは空白と末尾スラッシュを無視して突合する", () => {
    const allowed = parseAllowedOrigins(" https://a.test/ , https://b.test ,, ");
    expect(allowed).toEqual(["https://a.test", "https://b.test"]);
    const url = new URL("https://worker.test/api/session");
    expect(isOriginAllowed("https://a.test", url, allowed)).toBe(true);
    expect(isOriginAllowed("https://b.test/", url, allowed)).toBe(true);
    expect(isOriginAllowed("https://c.test", url, allowed)).toBe(false);
    // 許可リストを明示したら、同一オリジンであっても列挙されていなければ通さない。
    expect(isOriginAllowed("https://worker.test", url, allowed)).toBe(false);
  });

  it("ALLOWED_ORIGINS未設定ならリクエストURLと同じoriginだけを許可する", () => {
    const allowed = parseAllowedOrigins(undefined);
    const url = new URL("https://worker.test/api/session");
    expect(allowed).toEqual([]);
    expect(isOriginAllowed("https://worker.test", url, allowed)).toBe(true);
    expect(isOriginAllowed("https://worker.test/", url, allowed)).toBe(true);
    expect(isOriginAllowed("http://worker.test", url, allowed)).toBe(false);
    expect(isOriginAllowed(null, url, allowed)).toBe(false);
  });

  it("Origin無しはGETかつSec-Fetch-Siteが同一オリジン相当のときだけ通す", () => {
    expect(isOriginlessRequestAllowed("GET", "same-origin")).toBe(true);
    expect(isOriginlessRequestAllowed("GET", "none")).toBe(true);
    expect(isOriginlessRequestAllowed("GET", "cross-site")).toBe(false);
    expect(isOriginlessRequestAllowed("GET", null)).toBe(false);
    expect(isOriginlessRequestAllowed("POST", "same-origin")).toBe(false);
  });
});

describe("チームコード許可リスト（Pure Function）", () => {
  it("未設定だけがnull（＝何でも通す）", () => {
    expect(parseTeamCodes(undefined)).toBeNull();
    expect(isTeamCodeAllowed("999999", null)).toBe(true);
  });

  it("設定されているが空なら、fail-closedで全コードを拒否する", () => {
    // 「許可リストを効かせるつもりで値を間違えた」ケース。fail-openへ倒すと、
    // 設定したつもりのまま誰でも入れる状態を無言で作ってしまう。
    for (const raw of ["", "   ", ",", " , "]) {
      const allowlist = parseTeamCodes(raw);
      expect(allowlist, raw).not.toBeNull();
      expect(isTeamCodeAllowed("100001", allowlist), raw).toBe(false);
    }
  });

  it("設定した6桁だけを通す（空白は無視する）", () => {
    const allowlist = parseTeamCodes(" 100001, 100002 ");
    expect(isTeamCodeAllowed("100001", allowlist)).toBe(true);
    expect(isTeamCodeAllowed("100002", allowlist)).toBe(true);
    expect(isTeamCodeAllowed("100003", allowlist)).toBe(false);
  });
});

describe("レート制限の窓（Pure Function）", () => {
  it("同じ窓に入る時刻は同じbucketになり、窓が変われば変わる", () => {
    expect(rateLimitBucket(0, RATE_LIMIT_WINDOW_MS)).toBe("0");
    expect(rateLimitBucket(59_999, RATE_LIMIT_WINDOW_MS)).toBe("0");
    expect(rateLimitBucket(60_000, RATE_LIMIT_WINDOW_MS)).toBe("1");
  });

  it("Retry-Afterは窓が明けるまでの秒数で、最低1秒を返す", () => {
    expect(rateLimitRetryAfterSeconds(0, RATE_LIMIT_WINDOW_MS)).toBe(60);
    expect(rateLimitRetryAfterSeconds(59_500, RATE_LIMIT_WINDOW_MS)).toBe(1);
    expect(rateLimitRetryAfterSeconds(59_999, RATE_LIMIT_WINDOW_MS)).toBe(1);
  });

  it("CHAT_RATE_LIMIT_PER_MINUTEは1〜600の安全な整数だけ採用する", () => {
    expect(parseChatRateLimit("5")).toBe(5);
    expect(parseChatRateLimit("1")).toBe(MIN_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("600")).toBe(MAX_CHAT_RATE_LIMIT);
  });

  it.each([
    ["未設定", undefined],
    ["空文字", ""],
    ["0", "0"],
    ["負数", "-3"],
    ["小数", "2.5"],
    ["非数値", "abc"],
    ["範囲超過", "601"],
    ["指数表記の桁あふれ", "1e100"],
    ["安全整数を超える", "9007199254740993"],
    ["Infinity", "Infinity"],
  ])("CHAT_RATE_LIMIT_PER_MINUTEの%sは既定へ倒す", (_label, raw) => {
    expect(parseChatRateLimit(raw)).toBe(DEFAULT_CHAT_RATE_LIMIT);
  });
});

describe("入口ガード（Origin）", () => {
  it("許可Originのリクエストは通る", async () => {
    const response = await session("500001");
    expect(response.status).toBe(200);
  });

  it("不正OriginのPOSTは403で、DOにもAIにも触れない", async () => {
    const before = await listDurableObjectIds(env.TEAM_ROOM);
    const response = await fetchWithHeaders("/api/session", "POST", { Origin: OTHER_ORIGIN });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: "許可されていない送信元からのリクエストです。",
    });
    await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toEqual(before);
  });

  it("不正Originのチャット送信は403で、外部へ1回も出ずメッセージも保存しない", async () => {
    const threadId = await prepareThread("500002", messageCommandId(1));
    const before = await messageCountOf("500002");
    // 入口ガードはWorkerのfetch入口にあるためFakeAiGatewayを差し込めない。
    // OpenAiGatewayが使うグローバルfetchを数え、外部送信が0回であることを直接見る。
    const outbound = vi.spyOn(globalThis, "fetch");

    const response = await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/teams/500002/chat/messages`, {
        method: "POST",
        headers: { Origin: OTHER_ORIGIN },
        body: JSON.stringify({
          type: "send-message",
          commandId: messageCommandId(2),
          threadId,
          text: "本文",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockRestore();
    await expect(messageCountOf("500002")).resolves.toBe(before);
  });

  it("Origin無しのPOSTは、Sec-Fetch-Siteがsame-originでも403", async () => {
    const response = await fetchWithHeaders("/api/session", "POST", {
      "Sec-Fetch-Site": "same-origin",
    });
    expect(response.status).toBe(403);
  });

  it("同一オリジンのGET（Origin無し・Sec-Fetch-Site: same-origin）は通る", async () => {
    await session("500003");
    const response = await get("/api/teams/500003/chat");
    expect(response.status).toBe(200);
  });

  it("Sec-Fetch-Siteを持たないGET（curl相当）は403", async () => {
    await session("500004");
    const response = await fetchWithHeaders("/api/teams/500004/chat", "GET", {});
    expect(response.status).toBe(403);
  });

  it("WebSocket upgradeも不正Originなら403で、101にしない", async () => {
    await session("500005");
    const response = await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/teams/500005/sync`, {
        headers: { Upgrade: "websocket", Origin: OTHER_ORIGIN },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("/api/healthはOriginを問わない", async () => {
    const withBadOrigin = await fetchWithHeaders("/api/health", "GET", { Origin: OTHER_ORIGIN });
    expect(withBadOrigin.status).toBe(200);
    const withoutOrigin = await fetchWithHeaders("/api/health", "GET", {});
    expect(withoutOrigin.status).toBe(200);
  });

  it("ALLOWED_ORIGINSを設定すると、その別オリジンだけを通す", async () => {
    await withEnv({ ALLOWED_ORIGINS: ` ${OTHER_ORIGIN}/ ` }, async () => {
      const allowed = await fetchWithHeaders("/api/session", "POST", { Origin: OTHER_ORIGIN });
      expect(allowed.status).toBe(200);
      const rejected = await fetchWithHeaders("/api/session", "POST", { Origin: TEST_ORIGIN });
      expect(rejected.status).toBe(403);
    });
  });
});

describe("CORS", () => {
  it("エコーするのは許可判定を通った別オリジンだけ", () => {
    const url = new URL("https://worker.test/api/session");
    const allowed = parseAllowedOrigins("https://a.test");
    expect(corsHeadersFor("https://a.test", url, allowed)).toEqual({
      "Access-Control-Allow-Origin": "https://a.test",
      Vary: "Origin",
    });
    // 許可外はエコーしない（前作の `origin || "*"` 事故を再現させない）。
    expect(corsHeadersFor("https://evil.test", url, allowed)).toEqual({});
    // 同一オリジンにはCORSが要らない。
    expect(corsHeadersFor("https://worker.test", url, [])).toEqual({});
    expect(corsHeadersFor(null, url, allowed)).toEqual({});
  });

  it("許可オリジンのpreflightは204で許可メソッドとヘッダーを返す", async () => {
    await withEnv({ ALLOWED_ORIGINS: OTHER_ORIGIN }, async () => {
      const response = await fetchWithHeaders("/api/session", "OPTIONS", { Origin: OTHER_ORIGIN });
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_ORIGIN);
      expect(response.headers.get("Vary")).toBe("Origin");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    });
  });

  it("不許可オリジンのpreflightは403でCORSヘッダーを返さない", async () => {
    await withEnv({ ALLOWED_ORIGINS: "https://allowed.test" }, async () => {
      const response = await fetchWithHeaders("/api/session", "OPTIONS", { Origin: OTHER_ORIGIN });
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  it("許可オリジンの通常リクエストにはACAOとVaryが付く", async () => {
    await withEnv({ ALLOWED_ORIGINS: OTHER_ORIGIN }, async () => {
      const response = await fetchWithHeaders("/api/session", "POST", { Origin: OTHER_ORIGIN });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_ORIGIN);
      expect(response.headers.get("Vary")).toBe("Origin");
    });
  });

  it("同一オリジンのリクエストにはCORSヘッダーを付けない", async () => {
    const response = await session("500020");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const sameOriginGet = await get("/api/teams/500020/chat");
    expect(sameOriginGet.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("WebSocketの101応答はCORSヘッダーで壊さない", async () => {
    await withEnv({ ALLOWED_ORIGINS: OTHER_ORIGIN }, async () => {
      await session("500021");
      const response = await exports.default.fetch(
        new Request(`${TEST_ORIGIN}/api/teams/500021/sync`, {
          headers: { Upgrade: "websocket", Origin: OTHER_ORIGIN },
        }),
      );
      expect(response.status).toBe(101);
      expect(response.webSocket).not.toBeNull();
      response.webSocket?.accept();
      response.webSocket?.close();
    });
  });
});

describe("ヘルスチェックのguards（レート制限の実効値）", () => {
  it("設定ミスで既定へ倒れたことがhealthから分かる", async () => {
    const saved = env.CHAT_RATE_LIMIT_PER_MINUTE;
    try {
      env.CHAT_RATE_LIMIT_PER_MINUTE = "1e100";
      const fellBack = await get("/api/health");
      await expect(fellBack.json()).resolves.toMatchObject({
        guards: { chatRateLimitPerMinute: DEFAULT_CHAT_RATE_LIMIT },
      });

      env.CHAT_RATE_LIMIT_PER_MINUTE = "42";
      const applied = await get("/api/health");
      await expect(applied.json()).resolves.toMatchObject({
        guards: { chatRateLimitPerMinute: 42 },
      });
    } finally {
      env.CHAT_RATE_LIMIT_PER_MINUTE = saved;
    }
  });
});

describe("入口ガード（チームコード許可リスト）", () => {
  it("TEAM_CODES未設定なら任意の6桁が通る", async () => {
    const response = await session("512345");
    expect(response.status).toBe(200);
  });

  it("TEAM_CODES設定時、未登録コードの入室は404でDOを作らない", async () => {
    await withEnv({ TEAM_CODES: " 500006 , 500007 " }, async () => {
      const before = await listDurableObjectIds(env.TEAM_ROOM);
      const rejected = await session("500008");
      expect(rejected.status).toBe(404);
      await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toEqual(before);

      const allowed = await session("500006");
      expect(allowed.status).toBe(200);
    });
  });

  it("TEAM_CODES設定時、未登録コードの/api/teams/*も404でDOを作らない", async () => {
    await withEnv({ TEAM_CODES: "500009" }, async () => {
      const before = await listDurableObjectIds(env.TEAM_ROOM);
      const chat = await get("/api/teams/500010/chat");
      expect(chat.status).toBe(404);
      const command = await postJson("/api/teams/500010/commands", {
        type: "enter-stage1",
        commandId: messageCommandId(3),
        expectedRevision: 0,
      });
      expect(command.status).toBe(404);
      await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toEqual(before);
    });
  });
});

describe("入口ガード（リーダーボード）", () => {
  it("TEAM_CODES設定時、未登録コードのリーダーボード購読は404でDOを作らない", async () => {
    await withEnv({ TEAM_CODES: "500030" }, async () => {
      const before = await listDurableObjectIds(env.RACE_LEADERBOARD);
      const rejected = await exports.default.fetch(
        new Request(`${TEST_ORIGIN}/api/leaderboard/sync?teamCode=500031`, {
          headers: { Upgrade: "websocket", Origin: TEST_ORIGIN },
        }),
      );
      expect(rejected.status).toBe(404);
      expect(rejected.webSocket).toBeNull();
      await expect(listDurableObjectIds(env.RACE_LEADERBOARD)).resolves.toEqual(before);
    });
  });

  it("TEAM_CODES設定時、登録済みコードのリーダーボード購読は通る", async () => {
    await withEnv({ TEAM_CODES: "500032" }, async () => {
      await session("500032");
      const response = await upgrade("/api/leaderboard/sync?teamCode=500032");
      expect(response.status).toBe(101);
      response.webSocket?.accept();
      response.webSocket?.close();
    });
  });
});

describe("ヘルスチェックのguards", () => {
  it("運用値の設定状況を返し、値そのものは伏せる", async () => {
    await withEnv({ TEAM_CODES: "100001,100002", ALLOWED_ORIGINS: OTHER_ORIGIN }, async () => {
      const response = await get("/api/health");
      const body = await response.json();
      expect(body).toEqual({
        status: "ok",
        guards: { teamCodes: true, allowedOrigins: true, chatRateLimitPerMinute: 20 },
      });
      expect(JSON.stringify(body)).not.toContain("100001");
      expect(JSON.stringify(body)).not.toContain(OTHER_ORIGIN);
    });
  });
});

describe("スレッド数の上限", () => {
  const createThread = (
    teamCode: string,
    commandId: string,
    title: string,
    kind?: "stage" | "manual",
  ): Promise<Response> =>
    postJson(`/api/teams/${teamCode}/chat/threads`, {
      type: "create-thread",
      commandId,
      title,
      ...(kind === undefined ? {} : { kind }),
    });

  const threadsOf = async (teamCode: string): Promise<number> => {
    const response = await get(`/api/teams/${teamCode}/chat`);
    return chatSnapshotSchema.parse(await response.json()).threads.length;
  };

  it("手動スレッドは上限まで作れ、超えた分は409でDOに保存しない", async () => {
    await session("500040");
    // 入室時点のメインスレッドはkindを持たない＝manualとして数える。
    const initial = await threadsOf("500040");
    expect(initial).toBe(1);

    for (let index = initial; index < MAX_MANUAL_THREADS_PER_TEAM; index += 1) {
      const response = await createThread(
        "500040",
        messageCommandId(2000 + index),
        `副${String(index)}`,
      );
      expect(response.status, `#${String(index)}`).toBe(200);
    }

    const blocked = await createThread("500040", messageCommandId(2100), "あふれる");
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      message: expect.stringContaining(String(MAX_MANUAL_THREADS_PER_TEAM)),
    });
    await expect(threadsOf("500040")).resolves.toBe(MAX_MANUAL_THREADS_PER_TEAM);
  });

  it("手動を使い切ってもステージ用スレッドは作れる（枠は独立）", async () => {
    await session("500042");
    const initial = await threadsOf("500042");
    for (let index = initial; index < MAX_MANUAL_THREADS_PER_TEAM; index += 1) {
      await createThread("500042", messageCommandId(2500 + index), `副${String(index)}`);
    }
    expect((await createThread("500042", messageCommandId(2600), "あふれる")).status).toBe(409);

    // 手動が満杯でも、ステージ進行は止まらない。
    const stage = await createThread("500042", messageCommandId(2601), "Stage 1", "stage");
    expect(stage.status).toBe(200);
    await expect(threadsOf("500042")).resolves.toBe(MAX_MANUAL_THREADS_PER_TEAM + 1);
  });

  it("ステージ用スレッドは上限を超えると409で、文言が手動と違う", async () => {
    await session("500043");
    for (let index = 0; index < MAX_STAGE_THREADS_PER_TEAM; index += 1) {
      const response = await createThread(
        "500043",
        messageCommandId(2700 + index),
        `Stage ${String(index)}`,
        "stage",
      );
      expect(response.status, `#${String(index)}`).toBe(200);
    }

    const blocked = await createThread("500043", messageCommandId(2800), "Stage 9", "stage");
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      message: "ステージ用スレッドの上限に達しました。",
    });

    // ステージ枠を使い切っても、手動枠はまだ空いている。
    const manual = await createThread("500043", messageCommandId(2801), "手動");
    expect(manual.status).toBe(200);
  });

  it("kindを送らない既存クライアントの作成はmanualとして数える", async () => {
    await session("500044");
    const created = await createThread("500044", messageCommandId(2900), "副");
    expect(created.status).toBe(200);
    // manual枠だけが減っているので、ステージ枠は満額残っている。
    for (let index = 0; index < MAX_STAGE_THREADS_PER_TEAM; index += 1) {
      const response = await createThread(
        "500044",
        messageCommandId(2910 + index),
        `Stage ${String(index)}`,
        "stage",
      );
      expect(response.status, `#${String(index)}`).toBe(200);
    }
  });

  it("同じcommandIdで別のタイトルのスレッドを作ると409 conflict", async () => {
    await session("500045");
    const commandId = messageCommandId(3000);
    const first = await createThread("500045", commandId, "副1");
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // 内容が違う再送は冪等再送ではない。元の結果を返すと、クライアントは作った
    // つもりのスレッドが無いことに気づけない。
    const swapped = await createThread("500045", commandId, "別のタイトル");
    expect(swapped.status).toBe(409);
    expect(httpErrorSchema.parse(await swapped.json()).code).toBe("conflict");

    // kindだけ違う再送も同じ扱い。
    const otherKind = await createThread("500045", commandId, "副1", "stage");
    expect(otherKind.status).toBe(409);

    // 同じ内容の再送は従来どおり同じ結果を返す。
    const resent = await createThread("500045", commandId, "副1");
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toEqual(firstBody);
  });

  it("上限に達していても、処理済みcommandIdの再送は同じ結果を返す", async () => {
    await session("500041");
    const commandId = messageCommandId(2200);

    const firstResponse = await createThread("500041", commandId, "副1");
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();

    const initial = await threadsOf("500041");
    for (let index = initial; index < MAX_MANUAL_THREADS_PER_TEAM; index += 1) {
      await createThread("500041", messageCommandId(2300 + index), `副${String(index)}`);
    }
    expect((await createThread("500041", messageCommandId(2400), "あふれる")).status).toBe(409);

    // 上限に達した後でも、既に処理したcommandIdの再送は409にせず同じ結果を返す。
    const resent = await createThread("500041", commandId, "副1");
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toEqual(firstBody);
  });
});

describe("チャット送信のレート制限", () => {
  const windowStartMs = 1_756_000_000_000;

  it("既定の上限まで通し、超えた分は429でAIを呼ばず保存もしない", async () => {
    const threadId = await prepareThread("500011", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT));
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      const response = await sendChat(
        "500011",
        { commandId: messageCommandId(100 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
      expect(response.status).toBe(200);
    }
    const stored = await messageCountOf("500011");

    const blocked = await sendChat(
      "500011",
      { commandId: messageCommandId(200), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe(
      String(rateLimitRetryAfterSeconds(windowStartMs, RATE_LIMIT_WINDOW_MS)),
    );
    await expect(blocked.json()).resolves.toMatchObject({
      message: "送信が多すぎます。少し待ってから再試行してください。",
    });
    expect(gateway.requests).toHaveLength(DEFAULT_CHAT_RATE_LIMIT);
    await expect(messageCountOf("500011")).resolves.toBe(stored);
  });

  it("窓が変われば再び送れる", async () => {
    const threadId = await prepareThread("500012", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT + 1));
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      await sendChat(
        "500012",
        { commandId: messageCommandId(300 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
    }
    expect(
      (
        await sendChat(
          "500012",
          { commandId: messageCommandId(400), threadId, text: "本文" },
          gateway,
          windowStartMs,
        )
      ).status,
    ).toBe(429);

    const revived = await sendChat(
      "500012",
      { commandId: messageCommandId(401), threadId, text: "本文" },
      gateway,
      windowStartMs + RATE_LIMIT_WINDOW_MS,
    );
    expect(revived.status).toBe(200);
  });

  it("処理済みcommandIdの再送は枠を消費せず、同じ結果を返す", async () => {
    const threadId = await prepareThread("500013", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT));
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      await sendChat(
        "500013",
        { commandId: messageCommandId(500 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
    }

    // 枠は使い切っているが、再送は「新しい送信」ではないので通り、AIも呼び直さない。
    const resent = await sendChat(
      "500013",
      { commandId: messageCommandId(500), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(resent.status).toBe(200);
    expect(gateway.requests).toHaveLength(DEFAULT_CHAT_RATE_LIMIT);

    // 一方で、新しいcommandIdは同じ窓の中では拒否されたままである。
    const fresh = await sendChat(
      "500013",
      { commandId: messageCommandId(600), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(fresh.status).toBe(429);
  });
  it("存在しないスレッドへの送信は枠を消費しない", async () => {
    const threadId = await prepareThread("500014", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT));
    // 上限と同じ回数だけ不正なthreadIdへ投げる。枠を消費していれば、このあとの
    // 正当な送信が429になるはずである。
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      const rejected = await sendChat(
        "500014",
        {
          commandId: messageCommandId(700 + index),
          threadId: "00000000-0000-4000-8000-999999999999",
          text: "本文",
        },
        gateway,
        windowStartMs,
      );
      expect(rejected.status).toBe(404);
    }

    const accepted = await sendChat(
      "500014",
      { commandId: messageCommandId(800), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(accepted.status).toBe(200);
  });

  it("同じcommandIdの並行再送でも枠は1つしか減らない", async () => {
    const threadId = await prepareThread("500015", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT + 2));
    // 判定とpending行の作成が1つのDO操作なので、並行2本でも数えられるのは1回だけ。
    await Promise.all([
      sendChat(
        "500015",
        { commandId: messageCommandId(900), threadId, text: "本文" },
        gateway,
        windowStartMs,
      ),
      sendChat(
        "500015",
        { commandId: messageCommandId(900), threadId, text: "本文" },
        gateway,
        windowStartMs,
      ),
    ]);

    // 枠が1つだけ減っているなら、残りはlimit-1通。そこまで通り、その次が429になる。
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT - 1; index += 1) {
      const response = await sendChat(
        "500015",
        { commandId: messageCommandId(1000 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
      expect(response.status).toBe(200);
    }
    const blocked = await sendChat(
      "500015",
      { commandId: messageCommandId(1100), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(blocked.status).toBe(429);
  });

  it("上限に達した送信は枠・snapshot・pendingのどれも変えない", async () => {
    const threadId = await prepareThread("500017", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT));
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      await sendChat(
        "500017",
        { commandId: messageCommandId(1400 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
    }
    const before = await storageCountsOf("500017", windowStartMs);

    const blocked = await sendChat(
      "500017",
      { commandId: messageCommandId(1500), threadId, text: "本文" },
      gateway,
      windowStartMs,
    );

    expect(blocked.status).toBe(429);
    await expect(storageCountsOf("500017", windowStartMs)).resolves.toEqual(before);
  });

  it("rate_limitの行が壊れていても制限は効き続ける", async () => {
    const threadId = await prepareThread("500018", messageCommandId(1));
    // 型違いと負数を直接書き込む。素通しするとNaN比較で制限が黙って無効化される。
    const brokenValues: readonly (string | number)[] = ["こわれた", -5];
    for (const [round, broken] of brokenValues.entries()) {
      // 窓ごとにカウンタを分けて、ラウンド間で枠を引き継がないようにする。
      const roundNowMs = windowStartMs + round * RATE_LIMIT_WINDOW_MS;
      const roundBucket = rateLimitBucket(roundNowMs, RATE_LIMIT_WINDOW_MS);
      await runInDurableObject(env.TEAM_ROOM.getByName("500018"), (_instance, state) => {
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)",
          roundBucket,
          broken,
        );
      });

      const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT));
      // 壊れた行は0扱いで上書きされるので、ここから上限ぶんちょうど通る。
      const base = 1600 + round * 100;
      for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
        const response = await sendChat(
          "500018",
          { commandId: messageCommandId(base + index), threadId, text: "本文" },
          gateway,
          roundNowMs,
        );
        expect(response.status, `${String(broken)}#${String(index)}`).toBe(200);
      }
      const blocked = await sendChat(
        "500018",
        { commandId: messageCommandId(base + 50), threadId, text: "本文" },
        gateway,
        roundNowMs,
      );
      expect(blocked.status, String(broken)).toBe(429);
    }
  });

  it("上限に達した送信はpending行を残さず、窓が明ければ同じcommandIdで再送できる", async () => {
    const threadId = await prepareThread("500016", messageCommandId(1));
    const gateway = new FakeAiGateway(successOutcomes(DEFAULT_CHAT_RATE_LIMIT + 1));
    for (let index = 0; index < DEFAULT_CHAT_RATE_LIMIT; index += 1) {
      await sendChat(
        "500016",
        { commandId: messageCommandId(1200 + index), threadId, text: "本文" },
        gateway,
        windowStartMs,
      );
    }
    const stored = await messageCountOf("500016");

    const blockedId = messageCommandId(1300);
    const blocked = await sendChat(
      "500016",
      { commandId: blockedId, threadId, text: "本文" },
      gateway,
      windowStartMs,
    );
    expect(blocked.status).toBe(429);
    // pending行が作られていれば、次の窓で同じcommandIdを送っても"in-progress"（409）に
    // なってしまう。200が返るなら、429の時点で何も書いていない。
    await expect(messageCountOf("500016")).resolves.toBe(stored);

    const retried = await sendChat(
      "500016",
      { commandId: blockedId, threadId, text: "本文" },
      gateway,
      windowStartMs + RATE_LIMIT_WINDOW_MS,
    );
    expect(retried.status).toBe(200);
  });
});

describe("DO RPCの補助入力の検証（Pure Function）", () => {
  // Worker側で組み立てる値だが、DOのRPCは外から呼べる境界なので実行時に検証する。
  // 素通しするとNaNとの比較が常にfalseになり、レート制限が黙って無効化される。
  // 弾いた入力はDOが例外にし、Worker側のcatchが503へ倒す。
  it("nowMsは非負の安全な整数だけを受ける", () => {
    expect(nowMsSchema.safeParse(0).success).toBe(true);
    expect(nowMsSchema.safeParse(1_756_000_000_000).success).toBe(true);
    expect(nowMsSchema.safeParse(Number.MAX_SAFE_INTEGER - 1).success).toBe(true);
    for (const invalid of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, "1", null]) {
      expect(nowMsSchema.safeParse(invalid).success, String(invalid)).toBe(false);
    }
  });

  it("上限値は1〜MAX_CHAT_RATE_LIMITの整数だけを受ける", () => {
    expect(rateLimitCountSchema.safeParse(1).success).toBe(true);
    expect(rateLimitCountSchema.safeParse(MAX_CHAT_RATE_LIMIT).success).toBe(true);
    for (const invalid of [0, -5, 1.5, Number.NaN, MAX_CHAT_RATE_LIMIT + 1, "20"]) {
      expect(rateLimitCountSchema.safeParse(invalid).success, String(invalid)).toBe(false);
    }
  });

  it("指紋はSHA-256の16進64桁（小文字）だけを受ける", () => {
    expect(fingerprintSchema.safeParse("a".repeat(64)).success).toBe(true);
    for (const invalid of [
      "",
      "短すぎる",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
    ]) {
      expect(fingerprintSchema.safeParse(invalid).success, invalid.slice(0, 8)).toBe(false);
    }
  });

  it("claim generationは1以上の整数だけを受ける", () => {
    expect(claimGenerationSchema.safeParse(1).success).toBe(true);
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(claimGenerationSchema.safeParse(invalid).success, String(invalid)).toBe(false);
    }
  });

  it("beginChatMessageのgateは3項目そろって初めて通る", () => {
    const valid = { nowMs: 1_756_000_000_000, limit: 20, fingerprint: "a".repeat(64) };
    expect(beginChatGateSchema.safeParse(valid).success).toBe(true);
    expect(beginChatGateSchema.safeParse({ ...valid, nowMs: Number.NaN }).success).toBe(false);
    expect(beginChatGateSchema.safeParse({ ...valid, limit: 0 }).success).toBe(false);
    expect(beginChatGateSchema.safeParse({ ...valid, fingerprint: "短い" }).success).toBe(false);
    // 余計な項目は落とさず弾く（strict）。
    expect(beginChatGateSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
