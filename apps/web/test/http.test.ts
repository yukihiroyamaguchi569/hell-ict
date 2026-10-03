import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createFetchHttpPort,
  getJson,
  parseRetryAfter,
  postJson,
  requestJson,
} from "../src/api/http.js";
import { FakeHttp, ok, unavailable } from "./fakes.js";

const schema = z.object({ value: z.number() }).strict();

describe("requestJson", () => {
  it("2xx で schema を通れば ok", async () => {
    const http = new FakeHttp(() => ok({ value: 1 }));
    await expect(requestJson(http, { method: "GET", path: "/x" }, schema)).resolves.toEqual({
      kind: "ok",
      value: { value: 1 },
    });
  });

  it.each([200, 204, 299])("%s は成功の範囲", async (status) => {
    const http = new FakeHttp(() => ({ status, body: { value: 2 } }));
    const result = await requestJson(http, { method: "GET", path: "/x" }, schema);
    expect(result.kind).toBe("ok");
  });

  it.each([199, 300, 400, 500])("%s は http-error", async (status) => {
    const http = new FakeHttp(() => ({ status, body: { value: 2 } }));
    const result = await requestJson(http, { method: "GET", path: "/x" }, schema);
    expect(result).toEqual({ kind: "http-error", status, error: null, retryAfterSeconds: null });
  });

  it("2xx でも schema を通らなければ invalid-response（値は渡さない）", async () => {
    const http = new FakeHttp(() => ok({ value: "1" }));
    await expect(requestJson(http, { method: "GET", path: "/x" }, schema)).resolves.toEqual({
      kind: "invalid-response",
    });
  });

  it("Workerのエラー本文（message・code）を読む", async () => {
    const http = new FakeHttp(() => ({
      status: 409,
      body: { message: "古い", code: "stale-generation" },
    }));
    await expect(requestJson(http, { method: "POST", path: "/x" }, schema)).resolves.toEqual({
      kind: "http-error",
      status: 409,
      error: { message: "古い", code: "stale-generation" },
      retryAfterSeconds: null,
    });
  });

  it("エラー本文が JSON でない（404 の平文）なら error は null", async () => {
    const http = new FakeHttp(() => ({ status: 404, body: null }));
    await expect(requestJson(http, { method: "GET", path: "/x" }, schema)).resolves.toEqual({
      kind: "http-error",
      status: 404,
      error: null,
      retryAfterSeconds: null,
    });
  });

  it("429 の Retry-After を秒数で読む", async () => {
    const http = new FakeHttp(() => ({
      status: 429,
      body: { message: "送信が多すぎます。" },
      retryAfter: "12",
    }));
    await expect(requestJson(http, { method: "POST", path: "/x" }, schema)).resolves.toEqual({
      kind: "http-error",
      status: 429,
      error: { message: "送信が多すぎます。" },
      retryAfterSeconds: 12,
    });
  });

  it("日付の Retry-After は clock の現在時刻からの秒数、clock が無ければ null", async () => {
    const http = new FakeHttp(() => ({
      status: 429,
      body: null,
      retryAfter: "Sat, 31 Oct 2026 01:00:45 GMT",
    }));
    const clock = { now: () => new Date("2026-10-31T01:00:00.000Z") };
    const withClock = await requestJson(http, { method: "POST", path: "/x" }, schema, clock);
    expect(withClock.kind === "http-error" && withClock.retryAfterSeconds).toBe(45);
    const withoutClock = await requestJson(http, { method: "POST", path: "/x" }, schema);
    expect(withoutClock.kind === "http-error" && withoutClock.retryAfterSeconds).toBeNull();
  });

  it("503 の本文も読む", async () => {
    const http = new FakeHttp(unavailable);
    const result = await requestJson(http, { method: "GET", path: "/x" }, schema);
    expect(result.kind === "http-error" && result.error?.message).toBe(
      "時間を置いて再試行してください。",
    );
  });

  it("応答が無ければ（通信断・タイムアウト）network-error で、例外を投げない", async () => {
    const http = new FakeHttp(() => {
      throw new Error("offline");
    });
    await expect(requestJson(http, { method: "GET", path: "/x" }, schema)).resolves.toEqual({
      kind: "network-error",
    });
  });

  it("getJson は本文なしの GET、postJson は本文つきの POST", async () => {
    const http = new FakeHttp(() => ok({ value: 1 }));
    await getJson(http, "/a", schema);
    await postJson(http, "/b", { x: 1 }, schema);
    expect(http.requests).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b", body: { x: 1 } },
    ]);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-10-31T01:00:00.000Z");

  it.each([
    ["0", 0],
    ["1", 1],
    [" 30 ", 30],
    ["120", 120],
  ])("秒の %j は %s 秒", (raw, seconds) => {
    expect(parseRetryAfter(raw, NOW)).toBe(seconds);
  });

  it("秒は現在時刻が無くても読める", () => {
    expect(parseRetryAfter("7", null)).toBe(7);
  });

  it.each([
    ["Sat, 31 Oct 2026 01:00:30 GMT", 30],
    ["Sat, 31 Oct 2026 01:02:00 GMT", 120],
    ["Sat, 31 Oct 2026 01:00:00 GMT", 0],
  ])("日付の %j は今からの %s 秒", (raw, seconds) => {
    expect(parseRetryAfter(raw, NOW)).toBe(seconds);
  });

  it("日付までの端数は切り上げる", () => {
    expect(parseRetryAfter("Sat, 31 Oct 2026 01:00:10 GMT", NOW - 500)).toBe(11);
  });

  it("過去の日付は 0 秒", () => {
    expect(parseRetryAfter("Sat, 31 Oct 2026 00:59:00 GMT", NOW)).toBe(0);
  });

  it("日付は現在時刻が無ければ読めないので null", () => {
    expect(parseRetryAfter("Sat, 31 Oct 2026 01:00:30 GMT", null)).toBeNull();
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["-1"],
    ["1e3"],
    ["0x10"],
    ["1.2"],
    ["+5"],
    ["abc"],
    ["Infinity"],
    ["2026-10-31T01:00:30Z"],
    ["Xyz, 99 Foo 2026 99:99:99 GMT"],
  ])("%j は読めないので null", (raw) => {
    expect(parseRetryAfter(raw, NOW)).toBeNull();
  });
});

describe("createFetchHttpPort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POST は JSON 本文と content-type を付け、応答の JSON を返す", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ value: 1 }), { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await createFetchHttpPort().send({
      method: "POST",
      path: "/p",
      body: { a: 1 },
    });
    expect(response).toEqual({ status: 201, body: { value: 1 }, retryAfter: null });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"a":1}');
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("GET は本文も content-type も付けない", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createFetchHttpPort().send({ method: "GET", path: "/g" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it("JSON でない本文は null として返す（エラー状態でも投げない）", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("Not found", { status: 404 })));
    await expect(createFetchHttpPort().send({ method: "GET", path: "/g" })).resolves.toEqual({
      status: 404,
      body: null,
      retryAfter: null,
    });
  });

  it("Retry-After ヘッダーをそのまま渡す", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response('{"message":"多すぎ"}', { status: 429, headers: { "Retry-After": "7" } }),
      ),
    );
    await expect(createFetchHttpPort().send({ method: "POST", path: "/p" })).resolves.toEqual({
      status: 429,
      body: { message: "多すぎ" },
      retryAfter: "7",
    });
  });

  it("通信断は reject する", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(createFetchHttpPort().send({ method: "GET", path: "/g" })).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("時間内に応答が無ければ中断して reject する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_input: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const sending = createFetchHttpPort(1_000).send({ method: "GET", path: "/g" });
    const assertion = expect(sending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
