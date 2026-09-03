import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { chatSnapshotSchema, createThreadResultSchema } from "@hell-ict/domain";
import { describe, expect, it, vi } from "vitest";

import {
  isOriginAllowed,
  isOriginlessRequestAllowed,
  isTeamCodeAllowed,
  parseAllowedOrigins,
  parseTeamCodes,
} from "../src/guard.js";
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
