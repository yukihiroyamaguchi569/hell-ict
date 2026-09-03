import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { chatSnapshotSchema, createThreadResultSchema } from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import type { FakeAiOutcome } from "@hell-ict/domain/fakes";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CHAT_RATE_LIMIT,
  isOriginAllowed,
  isOriginlessRequestAllowed,
  isTeamCodeAllowed,
  parseAllowedOrigins,
  parseChatRateLimit,
  parseTeamCodes,
  RATE_LIMIT_WINDOW_MS,
  rateLimitBucket,
  rateLimitRetryAfterSeconds,
} from "../src/guard.js";
import { handleChatMessage } from "../src/index.js";
import { get, postJson, session, TEST_ORIGIN } from "./support.js";

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
    env,
    teamCode,
    { aiGateway: gateway, nowMs },
  );

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
  it("未設定・空文字はnull（＝何でも通す）", () => {
    expect(parseTeamCodes(undefined)).toBeNull();
    expect(parseTeamCodes("  ,  ")).toBeNull();
    expect(isTeamCodeAllowed("999999", null)).toBe(true);
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

  it("CHAT_RATE_LIMIT_PER_MINUTEは正の整数だけ採用し、それ以外は既定へ倒す", () => {
    expect(parseChatRateLimit("5")).toBe(5);
    expect(parseChatRateLimit(undefined)).toBe(DEFAULT_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("")).toBe(DEFAULT_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("0")).toBe(DEFAULT_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("-3")).toBe(DEFAULT_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("2.5")).toBe(DEFAULT_CHAT_RATE_LIMIT);
    expect(parseChatRateLimit("たくさん")).toBe(DEFAULT_CHAT_RATE_LIMIT);
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
