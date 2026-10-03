import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import { createGameApi } from "../src/api/game-api.js";
import {
  COMMAND_RETRY_DELAYS_MS,
  createGameSession,
  TEAM_CODE_STORAGE_KEY,
} from "../src/composables/use-game-session.js";
import type { HttpRequest, HttpResponse } from "../src/ports.js";
import {
  deferred,
  FakeGameServer,
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  staleGeneration,
  START_MS,
  unavailable,
  viewBody,
} from "./fakes.js";

const IDS = Array.from(
  { length: 20 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

const setup = (options: { saved?: string } = {}) => {
  const server = new FakeGameServer();
  const http = new FakeHttp(server.handle);
  const storage = new FakeKeyValueStorage();
  if (options.saved !== undefined) storage.values.set(TEAM_CODE_STORAGE_KEY, options.saved);
  const scheduler = new FakeScheduler();
  const resume = new FakeResumeSignal();
  const clock = new FakeClock(new Date(START_MS));
  const session = createGameSession({
    api: createGameApi(http),
    clock,
    ids: new FakeIdGenerator(IDS),
    storage,
    scheduler,
    resume,
  });
  /** Runs every pending resend timer until nothing is left to wait for. */
  const settleTimers = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      await flush();
      scheduler.advanceBy(60_000);
    }
    await flush();
  };
  return { server, http, storage, scheduler, resume, clock, session, settleTimers };
};

const commandBody = (request: HttpRequest | undefined): Record<string, unknown> => {
  const body = request?.body;
  return typeof body === "object" && body !== null ? { ...body } : {};
};

const sessionThenGame = (http: FakeHttp): string[] =>
  http.requests.map((request) => `${request.method} ${request.path}`);

describe("入室", () => {
  it("POST /api/session で世代を受け取り、GET /game の状態を出して ready になる", async () => {
    const { http, session, storage } = setup();
    await expect(session.join("123456")).resolves.toBe("ok");
    expect(sessionThenGame(http)).toEqual(["POST /api/session", "GET /api/teams/123456/game"]);
    expect(http.requests[0]?.body).toEqual({ teamCode: "123456" });
    expect(session.status.value).toBe("ready");
    expect(session.teamCode.value).toBe("123456");
    expect(session.generation.value).toBe(3);
    expect(session.view.value?.pos).toBe(0);
    expect(session.view.value?.state.game.stage).toBe("prologue");
    // 画面の状態には応答の外側（status など）を持ち込まない。
    expect(Object.keys(session.view.value ?? {}).sort()).toEqual([
      "ai",
      "pos",
      "serverNow",
      "state",
    ]);
    expect(storage.values.get(TEAM_CODE_STORAGE_KEY)).toBe("123456");
  });

  it("入室中は joining で、コマンドは送らない（not-ready・送信0件）", async () => {
    const { http, session } = setup();
    const pendingSession = deferred();
    http.handler = () => pendingSession.promise;
    const joining = session.join("123456");
    expect(session.status.value).toBe("joining");
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "not-ready" });
    expect(http.to("/game/commands")).toHaveLength(0);
    pendingSession.resolve(unavailable());
    await joining;
  });

  it("入室前のコマンドは not-ready で、何も送らない", async () => {
    const { http, session } = setup();
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "not-ready" });
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [
      "通信断",
      (): HttpResponse => {
        throw new Error("offline");
      },
    ],
    ["503", unavailable],
    ["形の違う応答", () => ok({ teamCode: "123456" })],
  ])(
    "POST /api/session が%sなら failed で idle に戻り、GETもせず保存もしない",
    async (_label, answer) => {
      const { http, session, storage } = setup();
      http.handler = answer;
      await expect(session.join("123456")).resolves.toBe("failed");
      expect(session.status.value).toBe("idle");
      expect(session.teamCode.value).toBeNull();
      expect(session.view.value).toBeNull();
      expect(http.to("/game")).toHaveLength(0);
      expect(storage.values.has(TEAM_CODE_STORAGE_KEY)).toBe(false);
    },
  );

  it("GET /game が失敗したら ready にせず、世代も状態も持たない", async () => {
    const { http, server, session, storage } = setup();
    http.handler = (request) =>
      request.path.endsWith("/game") ? unavailable() : server.handle(request);
    await expect(session.join("123456")).resolves.toBe("failed");
    expect(session.status.value).toBe("idle");
    expect(session.generation.value).toBeNull();
    expect(storage.values.has(TEAM_CODE_STORAGE_KEY)).toBe(false);
  });

  it("規則外のチームコード（404）は not-found", async () => {
    const { http, session } = setup();
    http.handler = () => ({ status: 404, body: null });
    await expect(session.join("999999")).resolves.toBe("not-found");
    expect(session.status.value).toBe("idle");
  });

  it("並行して入室したら、最後に始めた入室だけを採る（遅れた応答で上書きしない）", async () => {
    const { http, server, session, storage } = setup();
    const slowSession = deferred();
    http.handler = (request) =>
      commandBody(request).teamCode === "111111" ? slowSession.promise : server.handle(request);
    const first = session.join("111111");
    await expect(session.join("222222")).resolves.toBe("ok");
    slowSession.resolve(ok(sessionBody("111111", 9)));
    await expect(first).resolves.toBe("superseded");
    expect(session.teamCode.value).toBe("222222");
    expect(session.generation.value).toBe(3);
    expect(storage.values.get(TEAM_CODE_STORAGE_KEY)).toBe("222222");
    // 追い越された入室は GET /game まで進まない。
    expect(http.to("/teams/111111/game")).toHaveLength(0);
  });

  it("GET /game の待ち中に追い越された入室も、後から状態を書き込まない", async () => {
    const { http, server, session } = setup();
    const slowGame = deferred();
    http.handler = (request) =>
      request.path === "/api/teams/111111/game" ? slowGame.promise : server.handle(request);
    const first = session.join("111111");
    await flush();
    await session.join("222222");
    slowGame.resolve(ok(viewBody(6)));
    await expect(first).resolves.toBe("superseded");
    expect(session.view.value?.pos).toBe(0);
    expect(session.teamCode.value).toBe("222222");
  });

  it("入室の応答でサーバ時計との差を測る", async () => {
    const { http, server, session, clock } = setup();
    http.handler = (request) => {
      if (!request.path.endsWith("/game")) return server.handle(request);
      clock.advanceBy(200);
      return ok(viewBody(0, START_MS + 60_000));
    };
    await session.join("123456");
    // 往復200msの中点（+100ms）でサーバが+60秒を読んだ。
    expect(session.serverClock.offsetMs.value).toBe(60_000 - 100);
    expect(session.serverClock.now()).toBe(START_MS + 200 + 59_900);
  });
});

describe("再読み込みからの復帰（localStorage）", () => {
  it("hasSavedTeam は保存済みの正しいコードがあるときだけ true（何も送らない）", () => {
    expect(setup({ saved: "123456" }).session.hasSavedTeam()).toBe(true);
    expect(setup().session.hasSavedTeam()).toBe(false);
    expect(setup({ saved: "12ab" }).session.hasSavedTeam()).toBe(false);
    const blocked = setup({ saved: "123456" });
    blocked.storage.failing = true;
    expect(blocked.session.hasSavedTeam()).toBe(false);
    expect(blocked.http.requests).toEqual([]);
  });

  it("保存済みのコードで自動的に入室し直す", async () => {
    const { http, session } = setup({ saved: "123456" });
    await expect(session.start()).resolves.toBe("ok");
    expect(sessionThenGame(http)).toEqual(["POST /api/session", "GET /api/teams/123456/game"]);
    expect(session.status.value).toBe("ready");
  });

  it("保存が無ければ何も送らず idle のまま", async () => {
    const { http, session } = setup();
    await expect(session.start()).resolves.toBe("none");
    expect(http.requests).toHaveLength(0);
    expect(session.status.value).toBe("idle");
  });

  it.each(["12345", "1234567", "abcdef", "１２３４５６", ""])(
    "保存値が6桁の数字でない（%s）なら復元しない",
    async (saved) => {
      const { http, session } = setup({ saved });
      await expect(session.start()).resolves.toBe("none");
      expect(http.requests).toHaveLength(0);
    },
  );

  it("復元に失敗したら restore-failed で操作させず、retry で入り直せる", async () => {
    const { http, server, session, storage } = setup({ saved: "123456" });
    http.handler = unavailable;
    await expect(session.start()).resolves.toBe("failed");
    expect(session.status.value).toBe("restore-failed");
    expect(session.view.value).toBeNull();
    expect(session.teamCode.value).toBe("123456");
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "not-ready" });
    expect(http.to("/game/commands")).toHaveLength(0);
    // 保存は消さない（通信が戻れば同じコードで入り直す）。
    expect(storage.values.get(TEAM_CODE_STORAGE_KEY)).toBe("123456");

    http.handler = server.handle;
    await expect(session.retry()).resolves.toBe("ok");
    expect(session.status.value).toBe("ready");
  });

  it("retry は restore-failed のときだけ動く", async () => {
    const { http, session } = setup();
    await expect(session.retry()).resolves.toBe("none");
    await session.join("123456");
    const before = http.requests.length;
    await expect(session.retry()).resolves.toBe("none");
    expect(http.requests).toHaveLength(before);
  });

  it("保存済みのコードが規則外（404）なら保存を消して idle に戻す", async () => {
    const { http, session, storage } = setup({ saved: "123456" });
    http.handler = () => ({ status: 404, body: null });
    await expect(session.start()).resolves.toBe("not-found");
    expect(session.status.value).toBe("idle");
    expect(storage.values.has(TEAM_CODE_STORAGE_KEY)).toBe(false);
  });

  it("localStorage が例外を投げても止まらない（復元なし・入室は成功）", async () => {
    const { http, session, storage } = setup({ saved: "123456" });
    storage.failing = true;
    await expect(session.start()).resolves.toBe("none");
    expect(http.requests).toHaveLength(0);
    await expect(session.join("123456")).resolves.toBe("ok");
    expect(session.status.value).toBe("ready");
  });

  it("404 の後始末で localStorage が例外を投げても止まらない", async () => {
    const { http, session, storage } = setup({ saved: "123456" });
    http.handler = () => {
      storage.failing = true;
      return { status: 404, body: null };
    };
    await expect(session.start()).resolves.toBe("not-found");
    expect(session.status.value).toBe("idle");
  });
});

describe("コマンドの送信", () => {
  it("commandId と世代を付けて送り、applied の状態を出す", async () => {
    const { http, session } = setup();
    await session.join("123456");
    const outcome = await session.send({
      type: "inbox.reply",
      mailId: "p0",
      text: "承知しました。",
    });
    expect(outcome.kind).toBe("done");
    expect(commandBody(http.to("/game/commands")[0])).toEqual({
      type: "inbox.reply",
      mailId: "p0",
      text: "承知しました。",
      commandId: IDS[0],
      generation: 3,
    });
    expect(session.view.value?.pos).toBe(1);
  });

  it("コマンドごとに新しい commandId を振る", async () => {
    const { http, session } = setup();
    await session.join("123456");
    await session.send({ type: "inbox.open" });
    await session.send({ type: "inbox.settle" });
    expect(http.to("/game/commands").map((request) => commandBody(request).commandId)).toEqual([
      IDS[0],
      IDS[1],
    ]);
  });

  it("503 には同じ commandId で間隔を広げて送り直し、適用は1回だけ", async () => {
    const { http, server, session, scheduler, settleTimers } = setup();
    await session.join("123456");
    let failures = 2;
    http.handler = (request) => {
      if (request.path.endsWith("/game/commands") && failures > 0) {
        failures -= 1;
        return unavailable();
      }
      return server.handle(request);
    };
    const sending = session.send({ type: "inbox.open" });
    await settleTimers();
    const outcome = await sending;
    expect(outcome.kind === "done" && outcome.response.status).toBe("applied");
    const commands = http.to("/game/commands");
    expect(commands).toHaveLength(3);
    expect(new Set(commands.map((request) => commandBody(request).commandId))).toEqual(
      new Set([IDS[0]]),
    );
    expect(scheduler.delays).toEqual(COMMAND_RETRY_DELAYS_MS.slice(0, 2));
    expect([...server.applied.values()]).toEqual([1]);
    expect(server.pos).toBe(1);
    expect(session.view.value?.pos).toBe(1);
  });

  it("適用されたのに応答が途切れたら、同じ commandId の再送は duplicate で、二重に進まない", async () => {
    const { http, server, session, settleTimers } = setup();
    await session.join("123456");
    let lost = true;
    http.handler = (request) => {
      const response = server.handle(request);
      if (request.path.endsWith("/game/commands") && lost) {
        lost = false;
        throw new Error("connection reset after the server applied it");
      }
      return response;
    };
    const sending = session.send({ type: "inbox.open" });
    await settleTimers();
    const outcome = await sending;
    expect(outcome.kind === "done" && outcome.response.status).toBe("duplicate");
    expect(server.pos).toBe(1);
    expect(server.applied.get(IDS[0] ?? "")).toBe(2);
    expect(session.view.value?.pos).toBe(1);
  });

  it("送り直しの上限に達したら unavailable（最初＋4回で打ち切る）", async () => {
    const { http, session, scheduler, settleTimers } = setup();
    await session.join("123456");
    http.handler = unavailable;
    const sending = session.send({ type: "inbox.open" });
    await settleTimers();
    await expect(sending).resolves.toEqual({ kind: "unavailable" });
    expect(http.to("/game/commands")).toHaveLength(1 + COMMAND_RETRY_DELAYS_MS.length);
    expect(scheduler.delays).toEqual([...COMMAND_RETRY_DELAYS_MS]);
    expect(session.status.value).toBe("ready");
  });

  it.each([
    ["400", { status: 400, body: { message: "commandの形式が不正です。" } }],
    ["409 conflict", { status: 409, body: { message: "別の内容です。", code: "conflict" } }],
    ["413", { status: 413, body: { message: "大きすぎます。" } }],
    ["200 だが形が違う", ok({ status: "applied" })],
  ])("%s は送り直さず failed で、状態も変えない", async (_label, response) => {
    const { http, session, scheduler } = setup();
    await session.join("123456");
    http.handler = () => response;
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "failed" });
    expect(http.to("/game/commands")).toHaveLength(1);
    expect(scheduler.delays).toEqual([]);
    expect(session.view.value?.pos).toBe(0);
    expect(session.status.value).toBe("ready");
  });

  it("rejected も duplicate も、応答の状態を採る", async () => {
    const { http, session } = setup();
    await session.join("123456");
    http.handler = () =>
      ok({ status: "rejected", reason: "stage-mismatch", judgement: null, ...viewBody(2) });
    const rejected = await session.send({ type: "s1.start" });
    expect(rejected.kind === "done" && rejected.response.status).toBe("rejected");
    expect(session.view.value?.pos).toBe(2);

    http.handler = () =>
      ok({ status: "duplicate", original: { events: [], judgement: null }, ...viewBody(4) });
    const duplicate = await session.send({ type: "s1.start" });
    expect(duplicate.kind === "done" && duplicate.response.status).toBe("duplicate");
    expect(session.view.value?.pos).toBe(4);
  });
});

describe("リセット世代切れ（stale-generation）", () => {
  it("409 stale-generation で stale になり、以後の書き込みは1件も送らない", async () => {
    const { http, session } = setup();
    await session.join("123456");
    http.handler = staleGeneration;
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "stale" });
    expect(session.status.value).toBe("stale");
    const sent = http.to("/game/commands").length;
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "stale" });
    await expect(session.send({ type: "advance", from: "prologue", to: "s1" })).resolves.toEqual({
      kind: "stale",
    });
    expect(http.to("/game/commands")).toHaveLength(sent);
  });

  it("送り直し待ちのコマンドも、stale になったらもう送らない", async () => {
    const { http, session, scheduler, settleTimers } = setup();
    await session.join("123456");
    http.handler = unavailable;
    const waiting = session.send({ type: "inbox.open" });
    await flush();
    expect(scheduler.pending).toBe(1);
    // 後から頼んだコマンドは、再送待ちのコマンドが終わるまでキューで待つ。
    const queued = session.send({ type: "inbox.settle" });
    http.handler = staleGeneration;
    await settleTimers();
    await expect(waiting).resolves.toEqual({ kind: "stale" });
    await expect(queued).resolves.toEqual({ kind: "stale" });
    // 最初の503と、再送で受けた409の2件だけ。キューの2本目は送らない。
    expect(http.to("/game/commands")).toHaveLength(2);
    expect(new Set(http.to("/game/commands").map((r) => commandBody(r).commandId))).toEqual(
      new Set([IDS[0]]),
    );
  });

  it("stale の後は再開の合図でも取り直さない", async () => {
    const { http, session, resume } = setup();
    await session.start();
    await session.join("123456");
    http.handler = staleGeneration;
    await session.send({ type: "inbox.open" });
    const before = http.requests.length;
    resume.fire();
    await flush();
    expect(http.requests).toHaveLength(before);
  });

  it("markStale（チャットが世代切れを受けた）で stale になり、以後のコマンドは送らない", async () => {
    const { http, session } = setup();
    await session.join("123456");
    session.markStale();
    expect(session.status.value).toBe("stale");
    const before = http.requests.length;
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "stale" });
    expect(http.requests).toHaveLength(before);
  });

  it("markStale は入室前には何もしない（入室の画面を古いタブの案内で塞がない）", () => {
    const { session } = setup();
    session.markStale();
    expect(session.status.value).toBe("idle");
  });
});

describe("応答の順序", () => {
  it("状態を運ぶ要求は常に1本だけ飛ぶ（2本目のコマンドは1本目の応答を待つ）", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    const slowCommand = deferred();
    http.handler = (request) =>
      http.to("/game/commands").length === 1 ? slowCommand.promise : server.handle(request);
    const first = session.send({ type: "inbox.open" });
    const second = session.send({ type: "inbox.settle" });
    await flush();
    expect(http.to("/game/commands")).toHaveLength(1);
    slowCommand.resolve(ok({ status: "applied", events: [], judgement: null, ...viewBody(1) }));
    await first;
    await second;
    expect(http.to("/game/commands").map((r) => commandBody(r).type)).toEqual([
      "inbox.open",
      "inbox.settle",
    ]);
  });

  it("続けて頼んだ取り直しは、頼んだ順に1本ずつ出て、最後の状態が残る", async () => {
    const { http, session } = setup();
    await session.join("123456");
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    http.handler = () => queue.shift()?.promise ?? Promise.reject(new Error("unexpected"));
    const older = session.refresh();
    const newer = session.refresh();
    first.resolve(ok(viewBody(3)));
    await older;
    expect(session.view.value?.pos).toBe(3);
    second.resolve(ok(viewBody(5)));
    await newer;
    expect(session.view.value?.pos).toBe(5);
  });

  it("別のチームへ入り直した後に、前のチームの応答が届いても採らない", async () => {
    const { http, server, session } = setup();
    await session.join("111111");
    const slowCommand = deferred();
    http.handler = (request) =>
      request.path.endsWith("/game/commands") ? slowCommand.promise : server.handle(request);
    const sending = session.send({ type: "inbox.open" });
    await session.join("222222");
    slowCommand.resolve(ok({ status: "applied", events: [], judgement: null, ...viewBody(6) }));
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    expect(session.view.value?.pos).toBe(0);
    expect(session.teamCode.value).toBe("222222");
  });

  it("コマンドの応答待ちに取り直しを頼んでも、GETはコマンドの完了後に出て、コマンドの状態が残る", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Worker が先に届いたコマンドを後から適用する：応答が遅れる間、GET は適用前の状態を返す。
    http.handler = (request) =>
      request.path.endsWith("/game/commands")
        ? gate.then(() => server.handle(request))
        : server.handle(request);
    const sending = session.send({ type: "inbox.open" });
    await flush();
    const refreshing = session.refresh();
    await flush();
    expect(http.to("/game")).toHaveLength(1);
    release();
    await sending;
    await refreshing;
    expect(sessionThenGame(http).slice(-2)).toEqual([
      "POST /api/teams/123456/game/commands",
      "GET /api/teams/123456/game",
    ]);
    expect(session.view.value?.pos).toBe(1);
  });

  it("コマンドの応答待ちに同じチームへ入り直したら、初回GETはコマンドの完了後に出て、適用後の状態を出す", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commandAnswered = false;
    const getsAfterCommand: boolean[] = [];
    http.handler = (request) => {
      if (request.path.endsWith("/game/commands")) {
        return gate.then(() => {
          const response = server.handle(request);
          commandAnswered = true;
          return response;
        });
      }
      if (request.path.endsWith("/game")) getsAfterCommand.push(commandAnswered);
      return server.handle(request);
    };
    const sending = session.send({ type: "inbox.open" });
    await flush();
    const rejoining = session.join("123456");
    await flush();
    expect(getsAfterCommand).toEqual([]);
    release();
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    await expect(rejoining).resolves.toBe("ok");
    expect(getsAfterCommand).toEqual([true]);
    expect(session.view.value?.pos).toBe(1);
  });

  it("コマンドの応答待ちに入室を2回重ねても、後の入室の初回GETはコマンドの完了後に出る", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commandAnswered = false;
    const getsAfterCommand: boolean[] = [];
    http.handler = (request) => {
      if (request.path.endsWith("/game/commands")) {
        return gate.then(() => {
          const response = server.handle(request);
          commandAnswered = true;
          return response;
        });
      }
      if (request.path.endsWith("/game")) getsAfterCommand.push(commandAnswered);
      return server.handle(request);
    };
    const sending = session.send({ type: "inbox.open" });
    await flush();
    const joinA = session.join("123456");
    await flush();
    const joinB = session.join("123456");
    await flush();
    expect(getsAfterCommand).toEqual([]);
    release();
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    await expect(joinA).resolves.toBe("superseded");
    await expect(joinB).resolves.toBe("ok");
    expect(getsAfterCommand).toEqual([true]);
    expect(session.view.value?.pos).toBe(1);
  });

  it("再送待ちのコマンドがあっても、入り直しの初回GETは待たずに出る（再送はしない）", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    http.handler = (request) =>
      request.path.endsWith("/game/commands") ? unavailable() : server.handle(request);
    const sending = session.send({ type: "inbox.open" });
    await flush();
    await expect(session.join("123456")).resolves.toBe("ok");
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    expect(http.to("/game/commands")).toHaveLength(1);
  });

  it("取り直しの最中に別のチームへの入室が失敗しても、前のチームの状態を後から出さない", async () => {
    const { http, session } = setup();
    await session.join("111111");
    const slowGame = deferred();
    http.handler = (request) =>
      request.path === "/api/teams/111111/game" ? slowGame.promise : unavailable();
    const refreshing = session.refresh();
    await expect(session.join("222222")).resolves.toBe("failed");
    slowGame.resolve(ok(viewBody(5)));
    await refreshing;
    expect(session.status.value).toBe("idle");
    expect(session.view.value).toBeNull();
  });

  it("送り直し待ちの間に別のチームへ入ったら、前のチームへは送り直さない", async () => {
    const { http, server, session, settleTimers } = setup();
    await session.join("111111");
    http.handler = (request) =>
      request.path.endsWith("/game/commands") ? unavailable() : server.handle(request);
    const sending = session.send({ type: "inbox.open" });
    await flush();
    await session.join("222222");
    await settleTimers();
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    expect(http.to("/teams/111111/game/commands")).toHaveLength(1);
  });
});

describe("再開の合図（visibilitychange / online）", () => {
  it("合図で GET /game を取り直し、新しい状態を出す", async () => {
    const { http, server, session, resume } = setup({ saved: "123456" });
    await session.start();
    server.pos = 4;
    resume.fire();
    await flush();
    expect(http.to("/game")).toHaveLength(2);
    expect(session.view.value?.pos).toBe(4);
  });

  it("取り直しが失敗しても、最後の状態を出したままにする", async () => {
    const { http, session, resume } = setup({ saved: "123456" });
    await session.start();
    http.handler = () => {
      throw new Error("offline");
    };
    resume.fire();
    await flush();
    expect(session.view.value?.pos).toBe(0);
    expect(session.status.value).toBe("ready");
  });

  it("入室していなければ取り直さない", async () => {
    const { http, session, resume } = setup();
    await session.start();
    resume.fire();
    await flush();
    expect(http.requests).toHaveLength(0);
  });

  it("start を2回呼んでも購読は1本", async () => {
    const { session, resume } = setup();
    await session.start();
    await session.start();
    expect(resume.listeners.size).toBe(1);
  });
});

describe("後片付け", () => {
  it("dispose で購読をやめ、送り直し待ちも打ち切る", async () => {
    const { http, session, resume, scheduler } = setup({ saved: "123456" });
    await session.start();
    http.handler = unavailable;
    const sending = session.send({ type: "inbox.open" });
    await flush();
    session.dispose();
    await expect(sending).resolves.toEqual({ kind: "superseded" });
    expect(resume.listeners.size).toBe(0);
    expect(scheduler.pending).toBe(0);
    expect(http.to("/game/commands")).toHaveLength(1);
  });

  it.each(["/api/session", "/api/teams/123456/game"])(
    "入室の応答待ち（%s）の間に scope を止めたら、応答が来ても ready にならず保存もしない",
    async (waitingPath) => {
      const scope = effectScope();
      const { http, server, session, storage } = scope.run(() => setup()) ?? setup();
      const slow = deferred();
      http.handler = (request) =>
        request.path === waitingPath ? slow.promise : server.handle(request);
      const joining = session.join("123456");
      await flush();
      scope.stop();
      slow.resolve(server.handle({ method: "GET", path: waitingPath }));
      await expect(joining).resolves.toBe("superseded");
      expect(session.status.value).not.toBe("ready");
      expect(session.view.value).toBeNull();
      expect(session.generation.value).toBeNull();
      expect(storage.values.has(TEAM_CODE_STORAGE_KEY)).toBe(false);
    },
  );

  it("dispose でキューに積まれたコマンドも送らずに終わる", async () => {
    const { http, session, scheduler, settleTimers } = setup({ saved: "123456" });
    await session.start();
    http.handler = unavailable;
    const waiting = session.send({ type: "inbox.open" });
    const queued = session.send({ type: "inbox.settle" });
    const refreshing = session.refresh();
    await flush();
    session.dispose();
    await settleTimers();
    await expect(waiting).resolves.toEqual({ kind: "superseded" });
    await expect(queued).resolves.toEqual({ kind: "superseded" });
    await refreshing;
    expect(scheduler.pending).toBe(0);
    expect(http.to("/game/commands")).toHaveLength(1);
    expect(http.to("/game")).toHaveLength(1);
  });

  it("effectScope の中で作ると、scope の停止で片付く", async () => {
    const scope = effectScope();
    const { session, resume } = scope.run(() => setup()) ?? setup();
    await session.start();
    expect(resume.listeners.size).toBe(1);
    scope.stop();
    expect(resume.listeners.size).toBe(0);
  });
});

describe("コマンドの出来事（onEvents）", () => {
  const AT = "2026-10-31T01:00:00.000Z";
  const enteredS2 = { type: "stage-entered", stage: "s2", at: AT } as const;

  it("applied の出来事を1回だけ知らせ、duplicate は最初の適用の出来事を知らせる", async () => {
    const { http, session } = setup();
    await session.join("123456");
    const heard: unknown[] = [];
    session.onEvents((events) => heard.push(events));
    http.handler = () =>
      ok({ status: "applied", events: [enteredS2], judgement: null, ...viewBody(2) });
    await session.send({ type: "advance", from: "s1", to: "s2" });
    http.handler = () =>
      ok({
        status: "duplicate",
        original: { events: [enteredS2], judgement: null },
        ...viewBody(2),
      });
    await session.send({ type: "advance", from: "s1", to: "s2" });
    expect(heard).toEqual([[enteredS2], [enteredS2]]);
  });

  it("rejected・出来事なし・入室や取り直しでは知らせない", async () => {
    const { http, session } = setup();
    const heard: unknown[] = [];
    session.onEvents((events) => heard.push(events));
    await session.join("123456");
    await session.refresh();
    http.handler = () =>
      ok({ status: "rejected", reason: "not-cleared", judgement: null, ...viewBody(1) });
    await session.send({ type: "advance", from: "s1", to: "s2" });
    http.handler = () => ok({ status: "applied", events: [], judgement: null, ...viewBody(1) });
    await session.send({ type: "inbox.open" });
    expect(heard).toEqual([]);
  });

  it("503 の送り直しの末に届いても、知らせるのは届いた1回だけ", async () => {
    const { http, session, settleTimers } = setup();
    await session.join("123456");
    const heard: unknown[] = [];
    session.onEvents((events) => heard.push(events));
    const answers = [unavailable(), unavailable()];
    http.handler = () =>
      answers.shift() ??
      ok({ status: "applied", events: [enteredS2], judgement: null, ...viewBody(2) });
    const sending = session.send({ type: "advance", from: "s1", to: "s2" });
    await settleTimers();
    await sending;
    expect(heard).toEqual([[enteredS2]]);
  });

  it("別のチームへ入り直した後に届いた前のチームの出来事は知らせない", async () => {
    const { http, session } = setup();
    await session.join("123456");
    const heard: unknown[] = [];
    session.onEvents((events) => heard.push(events));
    const pending = deferred();
    http.handler = () => pending.promise;
    const sending = session.send({ type: "advance", from: "s1", to: "s2" });
    await flush();
    const server = new FakeGameServer();
    http.handler = server.handle;
    const joining = session.join("654321");
    pending.resolve(
      ok({ status: "applied", events: [enteredS2], judgement: null, ...viewBody(2) }),
    );
    await sending;
    await joining;
    expect(heard).toEqual([]);
  });

  it("購読をやめたら知らせない", async () => {
    const { http, session } = setup();
    await session.join("123456");
    const heard: unknown[] = [];
    const stop = session.onEvents((events) => heard.push(events));
    stop();
    http.handler = () =>
      ok({ status: "applied", events: [enteredS2], judgement: null, ...viewBody(2) });
    await session.send({ type: "advance", from: "s1", to: "s2" });
    expect(heard).toEqual([]);
  });
});

describe("会話の準備のやり直し（prepareStageThread）", () => {
  const THREAD_ID = "11111111-1111-4111-8111-111111111111";
  const THREAD_PATH = "/api/teams/123456/game/chat/thread";
  const readyView = (pos: number) => ({
    ...viewBody(pos),
    ai: { status: "ready", threadId: THREAD_ID, live: true },
  });

  it("世代を付けて POST .../game/chat/thread を1回送り、応答の状態（ready の AI）を出す", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    http.handler = (request) =>
      request.path === THREAD_PATH ? ok(readyView(3)) : server.handle(request);
    await expect(session.prepareStageThread()).resolves.toBe("done");
    expect(http.to("/game/chat/thread")).toEqual([
      { method: "POST", path: THREAD_PATH, body: { type: "prepare-stage-thread", generation: 3 } },
    ]);
    expect(session.view.value?.pos).toBe(3);
    expect(session.view.value?.ai).toEqual({ status: "ready", threadId: THREAD_ID, live: true });
  });

  it("応答の AI がまだ failed でも done で、その状態を出す", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    http.handler = (request) =>
      request.path === THREAD_PATH
        ? ok({ ...viewBody(3), ai: { status: "failed" } })
        : server.handle(request);
    await expect(session.prepareStageThread()).resolves.toBe("done");
    expect(session.view.value?.ai).toEqual({ status: "failed" });
  });

  it.each([
    [
      "通信断",
      (): HttpResponse => {
        throw new Error("offline");
      },
    ],
    ["503", unavailable],
    ["形の違う応答", () => ok({ state: null })],
    ["409（世代切れ以外）", () => ({ status: 409, body: { message: "処理中" } })],
  ])("%s なら failed で、送り直さず、前の状態を残す", async (_label, answer) => {
    const { http, server, session, scheduler } = setup();
    await session.join("123456");
    http.handler = (request) => (request.path === THREAD_PATH ? answer() : server.handle(request));
    await expect(session.prepareStageThread()).resolves.toBe("failed");
    expect(http.to("/game/chat/thread")).toHaveLength(1);
    expect(scheduler.pending).toBe(0);
    expect(session.view.value?.pos).toBe(0);
    expect(session.status.value).toBe("ready");
  });

  it("409 stale-generation で stale になり、以後は何も送らない", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    http.handler = (request) =>
      request.path === THREAD_PATH ? staleGeneration() : server.handle(request);
    await expect(session.prepareStageThread()).resolves.toBe("stale");
    expect(session.status.value).toBe("stale");
    const before = http.requests.length;
    await expect(session.prepareStageThread()).resolves.toBe("stale");
    await expect(session.send({ type: "inbox.open" })).resolves.toEqual({ kind: "stale" });
    expect(http.requests).toHaveLength(before);
  });

  it("入室前は not-ready で、何も送らない", async () => {
    const { http, session } = setup();
    await expect(session.prepareStageThread()).resolves.toBe("not-ready");
    expect(http.requests).toHaveLength(0);
  });

  it("入室中も not-ready で、何も送らない", async () => {
    const { http, session } = setup();
    const pendingSession = deferred();
    http.handler = () => pendingSession.promise;
    const joining = session.join("123456");
    await expect(session.prepareStageThread()).resolves.toBe("not-ready");
    expect(http.to("/game/chat/thread")).toHaveLength(0);
    pendingSession.resolve(unavailable());
    await joining;
  });

  it("コマンドの応答待ちに頼んでも、コマンドの完了後に出る（直列キューに載る）", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    const slowCommand = deferred();
    http.handler = (request) => {
      if (request.path === THREAD_PATH) return ok(readyView(1));
      return request.path.endsWith("/game/commands") ? slowCommand.promise : server.handle(request);
    };
    const sending = session.send({ type: "inbox.open" });
    const preparing = session.prepareStageThread();
    await flush();
    expect(http.to("/game/chat/thread")).toHaveLength(0);
    slowCommand.resolve(ok({ status: "applied", events: [], judgement: null, ...viewBody(1) }));
    await sending;
    await expect(preparing).resolves.toBe("done");
    expect(sessionThenGame(http).slice(-2)).toEqual([
      "POST /api/teams/123456/game/commands",
      `POST ${THREAD_PATH}`,
    ]);
    expect(session.view.value?.ai.status).toBe("ready");
  });

  it("応答待ちの間に別のチームへ入り直したら、前のチームの応答を採らない", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    const slow = deferred();
    http.handler = (request) =>
      request.path === THREAD_PATH ? slow.promise : server.handle(request);
    const preparing = session.prepareStageThread();
    await flush();
    const joining = session.join("222222");
    slow.resolve(ok(readyView(6)));
    await expect(preparing).resolves.toBe("superseded");
    await joining;
    expect(session.view.value?.pos).toBe(0);
    expect(session.view.value?.ai).toEqual({ status: "none" });
  });

  it("dispose の後にキューから出番が来ても送らない", async () => {
    const { http, server, session } = setup();
    await session.join("123456");
    const slowCommand = deferred();
    http.handler = (request) =>
      request.path.endsWith("/game/commands") ? slowCommand.promise : server.handle(request);
    void session.send({ type: "inbox.open" });
    const preparing = session.prepareStageThread();
    await flush();
    session.dispose();
    slowCommand.resolve(ok({ status: "applied", events: [], judgement: null, ...viewBody(1) }));
    await expect(preparing).resolves.toBe("superseded");
    expect(http.to("/game/chat/thread")).toHaveLength(0);
  });
});
