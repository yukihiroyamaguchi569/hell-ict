import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AI_ROUTE_HOLD_MS,
  aiRouteStatus,
  AiRouteState,
  createAiGateway,
  FailoverAiGateway,
  switchCauseOf,
} from "../src/ai-failover.js";
import type { AiEnv, AiRouteMeta } from "../src/ai-failover.js";
import { OpenAiGateway, OpenAiRefusalError, OpenAiRequestError } from "../src/openai-gateway.js";
import type { OpenAiFailure } from "../src/openai-gateway.js";

const BASE_URL = "https://example.test/v1";
const PRIMARY_KEY = "sk-primary-secret";
const BACKUP_KEY = "sk-backup-secret";
const PRIMARY_MODEL = "gpt-4o";
const BACKUP_MODEL = "gpt-4o-mini";

/** fetchへ届いた1回の呼び出し。どのキーでどのモデルを呼んだかだけを見る。 */
type Call = { readonly key: string; readonly model: string };

const requestBodySchema = z.object({ model: z.string() });

const callOf = (init: RequestInit | undefined): Call => ({
  key: new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "",
  model: requestBodySchema.parse(JSON.parse(String(init?.body))).model,
});

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

/** fetchを差し替え、呼び出しを`calls`へ記録する。応答はキーとモデルから決める。 */
const stubFetch = (respond: (call: Call, init: RequestInit | undefined) => Promise<Response>) => {
  calls = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const call = callOf(init);
    calls.push(call);
    return respond(call, init);
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ok = (text: string): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 }),
  );

const errorResponse = (status: number, code: string | null, type = "error"): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ error: { message: `sk-leak ${String(status)}`, type, code } }), {
      status,
    }),
  );

const quota = (): Promise<Response> =>
  errorResponse(429, "insufficient_quota", "insufficient_quota");

/** 主系（主キー・主モデル）だけを失敗させ、それ以外は成功させる応答。 */
const primaryFails =
  (failure: () => Promise<Response>) =>
  (call: Call): Promise<Response> =>
    call.key === PRIMARY_KEY && call.model === PRIMARY_MODEL
      ? failure()
      : ok(`ok:${call.key}:${call.model}`);

const primaryCall: Call = { key: PRIMARY_KEY, model: PRIMARY_MODEL };
const backupKeyCall: Call = { key: BACKUP_KEY, model: PRIMARY_MODEL };
const backupModelCall: Call = { key: PRIMARY_KEY, model: BACKUP_MODEL };

/** 差し替え可能な時計。 */
class FakeClock {
  constructor(public nowMs = 1_000_000) {}
  readonly now = (): number => this.nowMs;
}

type Backups = { key?: boolean; model?: boolean };

/** 予備の有無を選んで、実際のOpenAiGatewayで組んだFailoverAiGatewayを作る。 */
const failoverGateway = (
  backups: Backups,
  state: AiRouteState,
  clock: FakeClock,
): FailoverAiGateway =>
  new FailoverAiGateway(
    {
      primary: new OpenAiGateway(BASE_URL, PRIMARY_KEY, PRIMARY_MODEL),
      "backup-key":
        backups.key === true ? new OpenAiGateway(BASE_URL, BACKUP_KEY, PRIMARY_MODEL) : null,
      "backup-model":
        backups.model === true ? new OpenAiGateway(BASE_URL, PRIMARY_KEY, BACKUP_MODEL) : null,
    },
    state,
    clock.now,
  );

const REQUEST = { messages: [{ role: "user" as const, text: "患者メモ本文" }], timeoutMs: 1_000 };

/** 1回送って、成功ならtext、失敗なら投げられた例外を返す。 */
const send = async (
  gateway: FailoverAiGateway,
  timeoutMs = REQUEST.timeoutMs,
): Promise<unknown> => {
  try {
    return (await gateway.complete({ ...REQUEST, timeoutMs })).text;
  } catch (caught) {
    return caught;
  }
};

const failure = (overrides: Partial<OpenAiFailure>): OpenAiFailure => ({
  reason: "http_error",
  status: null,
  code: null,
  type: null,
  ...overrides,
});

describe("switchCauseOf（切り替えの対象になる失敗）", () => {
  it.each([
    ["429 insufficient_quota", failure({ status: 429, code: "insufficient_quota" }), "key"],
    ["401（キー失効・誤り）", failure({ status: 401, code: "invalid_api_key" }), "key"],
    ["401（本文なし）", failure({ status: 401 }), "key"],
    ["403（組織・プロジェクトの停止）", failure({ status: 403 }), "key"],
    ["404 model_not_found", failure({ status: 404, code: "model_not_found" }), "model"],
    ["404（本文なし）", failure({ status: 404 }), "model"],
    [
      "403 model_not_found（権限の無いモデル）",
      failure({ status: 403, code: "model_not_found" }),
      "model",
    ],
    ["400 model_not_found", failure({ status: 400, code: "model_not_found" }), "model"],
  ] as const)("%sは切り替える", (_label, input, expected) => {
    expect(switchCauseOf(input)).toBe(expected);
  });

  it.each([
    ["429 rate_limit_exceeded", failure({ status: 429, code: "rate_limit_exceeded" })],
    ["429（本文なし）", failure({ status: 429 })],
    ["400 invalid_request_error", failure({ status: 400, type: "invalid_request_error" })],
    ["408", failure({ status: 408 })],
    ["500", failure({ status: 500, type: "server_error" })],
    ["502", failure({ status: 502 })],
    ["503", failure({ status: 503 })],
    ["timeout", failure({ reason: "timeout" })],
    ["network", failure({ reason: "network" })],
    ["invalid_response", failure({ reason: "invalid_response" })],
    // http_error以外は、たとえcodeが付いていても切り替えない（理由の取り違え防止）。
    [
      "timeoutにinsufficient_quota",
      failure({ reason: "timeout", status: 429, code: "insufficient_quota" }),
    ],
  ] as const)("%sは切り替えない", (_label, input) => {
    expect(switchCauseOf(input)).toBeNull();
  });
});

describe("FailoverAiGateway", () => {
  it("主系の429 insufficient_quotaは予備キーで1回だけ送り直し、保持する", async () => {
    stubFetch(primaryFails(quota));
    const state = new AiRouteState();
    const clock = new FakeClock();
    const gateway = failoverGateway({ key: true, model: true }, state, clock);

    await expect(send(gateway)).resolves.toBe(`ok:${BACKUP_KEY}:${PRIMARY_MODEL}`);
    // 主系1回・予備1回。予備モデルには送らない（キーの問題はモデルを替えても直らない）。
    expect(calls).toEqual([primaryCall, backupKeyCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "backup-key", aiSwitchCause: "key" });
    expect(state.current(clock.nowMs)).toBe("backup-key");
  });

  it("主系の401は予備キーへ切り替える", async () => {
    stubFetch(primaryFails(() => errorResponse(401, "invalid_api_key")));
    const gateway = failoverGateway({ key: true }, new AiRouteState(), new FakeClock());
    await expect(send(gateway)).resolves.toBe(`ok:${BACKUP_KEY}:${PRIMARY_MODEL}`);
    expect(calls).toEqual([primaryCall, backupKeyCall]);
  });

  it("主系の403は予備キーへ切り替える", async () => {
    stubFetch(primaryFails(() => errorResponse(403, null)));
    const gateway = failoverGateway({ key: true }, new AiRouteState(), new FakeClock());
    await expect(send(gateway)).resolves.toBe(`ok:${BACKUP_KEY}:${PRIMARY_MODEL}`);
    expect(calls).toEqual([primaryCall, backupKeyCall]);
  });

  it("モデル起因（404 model_not_found）は主キーのまま予備モデルへ切り替える", async () => {
    stubFetch(primaryFails(() => errorResponse(404, "model_not_found")));
    const state = new AiRouteState();
    const clock = new FakeClock();
    const gateway = failoverGateway({ key: true, model: true }, state, clock);

    await expect(send(gateway)).resolves.toBe(`ok:${PRIMARY_KEY}:${BACKUP_MODEL}`);
    expect(calls).toEqual([primaryCall, backupModelCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "backup-model", aiSwitchCause: "model" });
    expect(state.current(clock.nowMs)).toBe("backup-model");
  });

  it("予備も失敗したら予備の失敗をそのまま投げ、保持しない（呼び出しは2回まで）", async () => {
    stubFetch(() => quota());
    const state = new AiRouteState();
    const clock = new FakeClock();
    const gateway = failoverGateway({ key: true, model: true }, state, clock);

    const caught = await send(gateway);
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    expect(calls).toEqual([primaryCall, backupKeyCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "backup-key", aiSwitchCause: "key" });
    expect(state.current(clock.nowMs)).toBe("primary");
  });

  it("予備が5xxで失敗しても、予備の失敗を投げて主系へは戻らない", async () => {
    stubFetch((call) => (call.key === PRIMARY_KEY ? quota() : errorResponse(500, null)));
    const gateway = failoverGateway({ key: true }, new AiRouteState(), new FakeClock());
    const caught = await send(gateway);
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    if (!(caught instanceof OpenAiRequestError)) throw new Error("unexpected");
    expect(caught.failure.status).toBe(500);
    expect(calls).toEqual([primaryCall, backupKeyCall]);
  });

  it("予備が未設定なら主系の失敗をそのまま投げる（従来どおり1回だけ）", async () => {
    stubFetch(primaryFails(quota));
    const state = new AiRouteState();
    const clock = new FakeClock();
    const gateway = failoverGateway({}, state, clock);

    const caught = await send(gateway);
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    if (!(caught instanceof OpenAiRequestError)) throw new Error("unexpected");
    expect(caught.failure.code).toBe("insufficient_quota");
    expect(calls).toEqual([primaryCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "primary" });
    expect(state.current(clock.nowMs)).toBe("primary");
  });

  it("キー起因で予備キーだけが未設定なら、予備モデルがあっても切り替えない", async () => {
    stubFetch(primaryFails(quota));
    const gateway = failoverGateway({ model: true }, new AiRouteState(), new FakeClock());
    expect(await send(gateway)).toBeInstanceOf(OpenAiRequestError);
    expect(calls).toEqual([primaryCall]);
  });

  it("モデル起因で予備モデルだけが未設定なら、予備キーがあっても切り替えない", async () => {
    stubFetch(primaryFails(() => errorResponse(404, "model_not_found")));
    const gateway = failoverGateway({ key: true }, new AiRouteState(), new FakeClock());
    expect(await send(gateway)).toBeInstanceOf(OpenAiRequestError);
    expect(calls).toEqual([primaryCall]);
  });

  it.each([
    ["429 rate_limit_exceeded", () => errorResponse(429, "rate_limit_exceeded", "requests")],
    ["500", () => errorResponse(500, null, "server_error")],
    ["503（本文なし）", () => Promise.resolve(new Response(null, { status: 503 }))],
    ["400 invalid_request_error", () => errorResponse(400, null, "invalid_request_error")],
    ["200で形の合わない本文", () => Promise.resolve(new Response("{}", { status: 200 }))],
    ["通信断", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%sでは予備が設定済みでも切り替えない（主系の1回だけ）", async (_label, respond) => {
    stubFetch((call) =>
      call.key === PRIMARY_KEY && call.model === PRIMARY_MODEL ? respond() : ok("backup"),
    );
    const state = new AiRouteState();
    const clock = new FakeClock();
    const gateway = failoverGateway({ key: true, model: true }, state, clock);

    const caught = await send(gateway);
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    expect(calls).toEqual([primaryCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "primary" });
    expect(state.current(clock.nowMs)).toBe("primary");
  });

  it("タイムアウトでは予備へ送り直さない（OpenAI側で課金されている可能性がある）", async () => {
    stubFetch((call, init) =>
      call.key === PRIMARY_KEY && call.model === PRIMARY_MODEL
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          })
        : ok("backup"),
    );
    const gateway = failoverGateway(
      { key: true, model: true },
      new AiRouteState(),
      new FakeClock(),
    );
    const caught = await send(gateway, 10);
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    if (!(caught instanceof OpenAiRequestError)) throw new Error("unexpected");
    expect(caught.failure.reason).toBe("timeout");
    expect(calls).toEqual([primaryCall]);
  });

  it("主系のポリシー拒否では切り替えない", async () => {
    stubFetch((call) =>
      call.key === PRIMARY_KEY && call.model === PRIMARY_MODEL
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: null, refusal: "対応できません" } }],
              }),
              { status: 200 },
            ),
          )
        : ok("backup"),
    );
    const gateway = failoverGateway(
      { key: true, model: true },
      new AiRouteState(),
      new FakeClock(),
    );
    expect(await send(gateway)).toBeInstanceOf(OpenAiRefusalError);
    expect(calls).toEqual([primaryCall]);
  });

  it("主系の成功では予備を呼ばず、経路はprimary", async () => {
    stubFetch((call) => ok(call.key));
    const gateway = failoverGateway(
      { key: true, model: true },
      new AiRouteState(),
      new FakeClock(),
    );
    await expect(send(gateway)).resolves.toBe(PRIMARY_KEY);
    expect(calls).toEqual([primaryCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "primary" });
  });
});

describe("FailoverAiGatewayの切り替え状態", () => {
  /** 主系をクレジット切れにして1回送り、予備キーへ切り替えた状態を作る。 */
  const switchToBackupKey = async (state: AiRouteState, clock: FakeClock): Promise<void> => {
    stubFetch(primaryFails(quota));
    await send(failoverGateway({ key: true }, state, clock));
    expect(state.current(clock.nowMs)).toBe("backup-key");
  };

  it("保持している間は主系を呼ばずに予備へ直接送る", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch(primaryFails(quota));
    clock.nowMs += AI_ROUTE_HOLD_MS - 1;
    const gateway = failoverGateway({ key: true }, state, clock);
    await expect(send(gateway)).resolves.toBe(`ok:${BACKUP_KEY}:${PRIMARY_MODEL}`);
    expect(calls).toEqual([backupKeyCall]);
    // この送信では切り替えていないので、原因は付けない。
    expect(gateway.routeMeta).toEqual({ aiRoute: "backup-key" });
  });

  it("保持が切れたら主系を試し、主系が戻っていれば主系へ戻る", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch((call) => ok(call.key));
    clock.nowMs += AI_ROUTE_HOLD_MS;
    expect(state.current(clock.nowMs)).toBe("primary");
    const gateway = failoverGateway({ key: true }, state, clock);
    await expect(send(gateway)).resolves.toBe(PRIMARY_KEY);
    expect(calls).toEqual([primaryCall]);
    expect(gateway.routeMeta).toEqual({ aiRoute: "primary" });
  });

  it("保持が切れた後も主系が使えなければ、もう一度予備へ切り替えて保持し直す", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch(primaryFails(quota));
    clock.nowMs += AI_ROUTE_HOLD_MS;
    const gateway = failoverGateway({ key: true }, state, clock);
    await expect(send(gateway)).resolves.toBe(`ok:${BACKUP_KEY}:${PRIMARY_MODEL}`);
    expect(calls).toEqual([primaryCall, backupKeyCall]);
    expect(state.current(clock.nowMs + AI_ROUTE_HOLD_MS - 1)).toBe("backup-key");
  });

  it("保持中の予備が確定的に失敗したら保持を解き、次の送信は主系から試す", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch(() => quota());
    expect(await send(failoverGateway({ key: true }, state, clock))).toBeInstanceOf(
      OpenAiRequestError,
    );
    // 保持中は予備の1回だけ。同じ送信の中で主系へは戻さない。
    expect(calls).toEqual([backupKeyCall]);
    expect(state.current(clock.nowMs)).toBe("primary");

    stubFetch((call) => ok(call.key));
    await expect(send(failoverGateway({ key: true }, state, clock))).resolves.toBe(PRIMARY_KEY);
    expect(calls).toEqual([primaryCall]);
  });

  it("保持中の予備が一時的な失敗（5xx）なら保持を続ける", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch(() => errorResponse(500, null));
    expect(await send(failoverGateway({ key: true }, state, clock))).toBeInstanceOf(
      OpenAiRequestError,
    );
    expect(calls).toEqual([backupKeyCall]);
    expect(state.current(clock.nowMs)).toBe("backup-key");
  });

  it("保持中の経路の予備が今は未設定なら、主系から試す", async () => {
    const state = new AiRouteState();
    const clock = new FakeClock();
    await switchToBackupKey(state, clock);

    stubFetch((call) => ok(call.key));
    await expect(send(failoverGateway({}, state, clock))).resolves.toBe(PRIMARY_KEY);
    expect(calls).toEqual([primaryCall]);
  });

  it("予備には主系が使い残した時間だけを渡し、使い切っていれば予備を呼ばない", async () => {
    const clock = new FakeClock();
    // 主系が応答するまでに時計を進める（主系の遅い失敗を模す）。
    const slowPrimary = (elapsedMs: number) => (call: Call) => {
      if (call.key === PRIMARY_KEY) {
        clock.nowMs += elapsedMs;
        return quota();
      }
      return ok("backup");
    };

    stubFetch(slowPrimary(999));
    await expect(send(failoverGateway({ key: true }, new AiRouteState(), clock))).resolves.toBe(
      "backup",
    );
    expect(calls).toEqual([primaryCall, backupKeyCall]);

    stubFetch(slowPrimary(1_000));
    const caught = await send(failoverGateway({ key: true }, new AiRouteState(), clock));
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    expect(calls).toEqual([primaryCall]);
  });

  it("予備のタイムアウトは残り時間で打ち切られる", async () => {
    const clock = new FakeClock();
    let backupAbortedAt: number | null = null;
    const startedAt = Date.now();
    stubFetch((call, init) => {
      if (call.key === PRIMARY_KEY) {
        clock.nowMs += 950;
        return quota();
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          backupAbortedAt = Date.now() - startedAt;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const caught = await send(failoverGateway({ key: true }, new AiRouteState(), clock));
    expect(caught).toBeInstanceOf(OpenAiRequestError);
    if (!(caught instanceof OpenAiRequestError)) throw new Error("unexpected");
    expect(caught.failure.reason).toBe("timeout");
    // 残り50msで打ち切られる（1,000msのまま渡していれば1秒近く待つ）。
    expect(backupAbortedAt).not.toBeNull();
    expect(backupAbortedAt ?? Infinity).toBeLessThan(500);
  });
});

describe("AiRouteState", () => {
  it("初期はprimaryで、保持の境界ちょうどで主系へ戻る", () => {
    const state = new AiRouteState(100);
    expect(state.current(0)).toBe("primary");
    state.hold("backup-model", 1_000);
    expect(state.current(1_000)).toBe("backup-model");
    expect(state.current(1_099)).toBe("backup-model");
    expect(state.current(1_100)).toBe("primary");
    state.hold("backup-key", 2_000);
    state.release();
    expect(state.current(2_000)).toBe("primary");
  });
});

/** envを一時的に差し替えて実行する（healthと設定の読み取り用）。 */
const withBackupEnv = async <T>(
  overrides: Partial<Pick<Env, "OPENAI_API_KEY_BACKUP" | "OPENAI_MODEL_BACKUP">>,
  run: () => Promise<T>,
): Promise<T> => {
  const saved = {
    OPENAI_API_KEY_BACKUP: env.OPENAI_API_KEY_BACKUP,
    OPENAI_MODEL_BACKUP: env.OPENAI_MODEL_BACKUP,
  };
  Object.assign(env, overrides);
  try {
    return await run();
  } finally {
    Object.assign(env, saved);
  }
};

describe("createAiGatewayの設定の読み取り", () => {
  const testEnv = (overrides: Partial<AiEnv>): AiEnv => ({
    OPENAI_BASE_URL: BASE_URL,
    OPENAI_API_KEY: PRIMARY_KEY,
    OPENAI_MODEL: PRIMARY_MODEL,
    ...overrides,
  });

  const routeAfterQuota = async (overrides: Partial<AiEnv>): Promise<AiRouteMeta> => {
    stubFetch(primaryFails(quota));
    const gateway = createAiGateway(testEnv(overrides), new AiRouteState());
    if (!(gateway instanceof FailoverAiGateway)) throw new Error("unexpected");
    await gateway.complete(REQUEST).catch(() => null);
    return gateway.routeMeta;
  };

  it("OPENAI_API_KEY_BACKUPを予備キーとして使う", async () => {
    await expect(routeAfterQuota({ OPENAI_API_KEY_BACKUP: BACKUP_KEY })).resolves.toEqual({
      aiRoute: "backup-key",
      aiSwitchCause: "key",
    });
    expect(calls).toEqual([primaryCall, backupKeyCall]);
  });

  it.each([
    ["未設定", undefined],
    ["空文字", ""],
    ["主キーと同じ値", PRIMARY_KEY],
  ])("予備キーが%sなら予備なしとして扱う", async (_label, value) => {
    await expect(routeAfterQuota({ OPENAI_API_KEY_BACKUP: value })).resolves.toEqual({
      aiRoute: "primary",
    });
    expect(calls).toEqual([primaryCall]);
  });

  it("予備モデルが空文字・主モデルと同じなら予備なしとして扱う", () => {
    for (const value of ["", PRIMARY_MODEL]) {
      expect(
        aiRouteStatus(testEnv({ OPENAI_MODEL_BACKUP: value }), new AiRouteState(), 0),
      ).toMatchObject({ backupModel: false });
    }
    expect(
      aiRouteStatus(testEnv({ OPENAI_MODEL_BACKUP: BACKUP_MODEL }), new AiRouteState(), 0),
    ).toMatchObject({ backupModel: true });
  });
});

describe("/api/healthのai", () => {
  it("未設定なら予備なし・主系と出る", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/api/health"));
    await expect(response.json()).resolves.toMatchObject({
      ai: { route: "primary", backupKey: false, backupModel: false },
    });
  });

  it("予備が設定済みなら設定の有無だけを出し、キーの値・一部は出さない", async () => {
    await withBackupEnv(
      { OPENAI_API_KEY_BACKUP: "sk-proj-backupSECRET1234", OPENAI_MODEL_BACKUP: BACKUP_MODEL },
      async () => {
        const response = await exports.default.fetch(
          new Request("https://example.test/api/health"),
        );
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          ai: { route: "primary", backupKey: true, backupModel: true },
        });
        for (const leaked of ["sk-", "backupSECRET", "1234", env.OPENAI_API_KEY, BACKUP_MODEL]) {
          expect(text).not.toContain(leaked);
        }
      },
    );
  });

  it("切り替え中の経路を出す", () => {
    const state = new AiRouteState();
    state.hold("backup-key", 0);
    expect(aiRouteStatus({ ...env, OPENAI_API_KEY_BACKUP: BACKUP_KEY }, state, 1)).toEqual({
      route: "backup-key",
      backupKey: true,
      backupModel: false,
    });
  });
});
