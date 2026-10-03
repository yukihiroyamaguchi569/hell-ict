import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { createGameApi } from "../../src/api/game-api.js";
import { useEntry } from "../../src/composables/use-entry.js";
import {
  createGameSession,
  TEAM_CODE_STORAGE_KEY,
} from "../../src/composables/use-game-session.js";
import {
  createTeamNameStore,
  teamNameKey,
  useTeamName,
} from "../../src/composables/use-team-name.js";
import type { HttpRequest, HttpResponse } from "../../src/ports.js";
import {
  deferred,
  FakeGameServer,
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  START_MS,
  unavailable,
} from "../fakes.js";

const HEALTHY = ok({ status: "ok", guards: {} });

type ProbeHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

const setup = (options: { saved?: string; probe?: ProbeHandler } = {}) => {
  const server = new FakeGameServer();
  const http = new FakeHttp(server.handle);
  const probeHttp = new FakeHttp(options.probe ?? (() => HEALTHY));
  const storage = new FakeKeyValueStorage();
  if (options.saved !== undefined) storage.values.set(TEAM_CODE_STORAGE_KEY, options.saved);
  const scope = effectScope();
  const built = scope.run(() => {
    const session = createGameSession({
      api: createGameApi(http),
      clock: new FakeClock(new Date(START_MS)),
      ids: new FakeIdGenerator(["00000000-0000-4000-8000-000000000001"]),
      storage,
      scheduler: new FakeScheduler(),
      resume: new FakeResumeSignal(),
    });
    const teamName = useTeamName(session.teamCode, createTeamNameStore(storage));
    const entry = useEntry({ session, probeHttp, teamName });
    return { session, teamName, entry };
  });
  if (built === undefined) throw new Error("effect scope did not run");
  return { server, http, probeHttp, storage, scope, ...built };
};

describe("疎通確認", () => {
  it("確認が終わるまでは入室できず、答えがあれば入室できる", async () => {
    const answer = deferred();
    const { entry, probeHttp } = setup({ probe: () => answer.promise });
    const started = entry.start();
    expect(entry.notice.value.canEnter).toBe(false);
    expect(probeHttp.requests).toEqual([{ method: "GET", path: "/api/health" }]);
    answer.resolve(HEALTHY);
    await started;
    expect(entry.notice.value).toMatchObject({ text: "", canEnter: true, retry: null });
  });

  it("503・HTML・通信断はどれも失敗で、［再試行］は疎通確認をやり直す", async () => {
    const answers: (() => HttpResponse)[] = [
      unavailable,
      () => ok("<!doctype html>"),
      () => {
        throw new Error("offline");
      },
    ];
    for (const answer of answers) {
      let healthy = false;
      const { entry, http } = setup({ probe: () => (healthy ? HEALTHY : answer()) });
      await entry.start();
      expect(entry.notice.value).toMatchObject({ bad: true, retry: "probe", canEnter: false });
      // API が不通の間は、ゲームの API へは何も送らない
      expect(http.requests).toEqual([]);
      healthy = true;
      await entry.retry();
      expect(entry.notice.value).toMatchObject({ bad: false, canEnter: true });
    }
  });

  it("不通の間は入室を押しても何も送らない", async () => {
    const { entry, http } = setup({ probe: unavailable });
    await entry.start();
    await entry.enter("123456", "A班");
    expect(http.requests).toEqual([]);
  });
});

describe("保存済みチームの復元", () => {
  it("疎通確認が通ってから復元し、同じチームへ戻る", async () => {
    const answer = deferred();
    const { entry, http, session } = setup({ saved: "123456", probe: () => answer.promise });
    const started = entry.start();
    await flush();
    expect(http.requests).toEqual([]);
    answer.resolve(HEALTHY);
    await started;
    expect(session.status.value).toBe("ready");
    expect(session.teamCode.value).toBe("123456");
  });

  it("疎通確認をやり直しても、復元は1回だけ走る", async () => {
    let healthy = false;
    const { entry, http } = setup({
      saved: "123456",
      probe: () => (healthy ? HEALTHY : unavailable()),
    });
    await entry.start();
    healthy = true;
    await entry.retry();
    await entry.start();
    expect(http.to("/api/session")).toHaveLength(1);
  });

  it("復元に失敗したら入室させず、［再試行］で復元をやり直す", async () => {
    const { entry, http, server, session } = setup({ saved: "123456" });
    const handle = server.handle;
    http.handler = (request) => (request.path === "/api/session" ? unavailable() : handle(request));
    await entry.start();
    expect(session.status.value).toBe("restore-failed");
    expect(entry.notice.value).toMatchObject({ bad: true, retry: "restore", canEnter: false });
    await entry.enter("654321", "B班");
    expect(http.to("/api/session")).toHaveLength(1);

    http.handler = handle;
    await entry.retry();
    expect(session.status.value).toBe("ready");
    expect(session.teamCode.value).toBe("123456");
  });

  it("このPCに残した名前をチームと一緒に戻す", async () => {
    const { entry, storage, teamName } = setup({ saved: "123456" });
    storage.values.set(teamNameKey("123456"), "発熱対策室");
    await entry.start();
    await nextTick();
    expect(teamName.name.value).toBe("発熱対策室");
  });
});

describe("フォームからの入室", () => {
  it("入室できたら名前をコードごとに残して表示する", async () => {
    const { entry, session, storage, teamName } = setup();
    await entry.start();
    await entry.enter("123456", " 発熱対策室 ");
    await nextTick();
    expect(session.status.value).toBe("ready");
    expect(storage.values.get(teamNameKey("123456"))).toBe("発熱対策室");
    expect(teamName.name.value).toBe("発熱対策室");
    expect(entry.error.value).toBe("");
  });

  it("形の誤りは送る前に止め、案内を出す", async () => {
    const { entry, http } = setup();
    await entry.start();
    await entry.enter("12345", "A班");
    expect(entry.error.value).toBe("チームコードはASCII数字6桁で入力してください。");
    await entry.enter("123456", " ");
    expect(entry.error.value).toContain("チーム名を入力してください");
    expect(http.requests).toEqual([]);
  });

  it("入室の最中は重ねて押しても1回しか送らない", async () => {
    const { entry, http, server } = setup();
    const answer = deferred();
    const handle = server.handle;
    http.handler = (request) =>
      request.path === "/api/session" ? answer.promise : handle(request);
    await entry.start();
    const first = entry.enter("123456", "A班");
    expect(entry.notice.value).toMatchObject({ text: "入室しています…", canEnter: false });
    await entry.enter("123456", "A班");
    answer.resolve(handle({ method: "POST", path: "/api/session" }));
    await first;
    expect(http.to("/api/session")).toHaveLength(1);
    expect(entry.notice.value.canEnter).toBe(true);
  });

  it("知らないコードと通信の失敗は、それぞれ案内を出して入室欄に戻す", async () => {
    const { entry, http, session } = setup();
    await entry.start();
    http.handler = () => ({ status: 404, body: null });
    await entry.enter("999999", "A班");
    expect(entry.error.value).toContain("コードを確かめてください");
    expect(session.status.value).toBe("idle");

    http.handler = unavailable;
    await entry.enter("123456", "A班");
    expect(entry.error.value).toContain("時間を置いて再試行してください");
    expect(entry.notice.value.canEnter).toBe(true);
  });

  it("前の失敗の案内は、次の入室が通ったら消える", async () => {
    const { entry, http, server } = setup();
    await entry.start();
    http.handler = unavailable;
    await entry.enter("123456", "A班");
    http.handler = server.handle;
    await entry.enter("123456", "A班");
    expect(entry.error.value).toBe("");
  });

  it("保存領域が例外を投げても入室は通る（名前は画面にだけ残る）", async () => {
    const { entry, session, storage, teamName } = setup();
    storage.failing = true;
    await entry.start();
    await entry.enter("123456", "A班");
    await nextTick();
    expect(session.status.value).toBe("ready");
    expect(storage.values.size).toBe(0);
    expect(teamName.name.value).toBe("A班");
  });
});

describe("useTeamName", () => {
  it("チームが替わったら、そのコードで残した名前に切り替える", async () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(teamNameKey("111111"), "A班");
    storage.values.set(teamNameKey("222222"), "B班".repeat(10));
    const scope = effectScope();
    const teamCode = ref<string | null>(null);
    const name = scope.run(() => useTeamName(teamCode, createTeamNameStore(storage)));
    expect(name?.name.value).toBe("");
    teamCode.value = "111111";
    await nextTick();
    expect(name?.name.value).toBe("A班");
    // 保存値も外部入力なので、チップに収まる長さへ切り詰める
    teamCode.value = "222222";
    await nextTick();
    expect(name?.name.value).toHaveLength(12);
    teamCode.value = null;
    await nextTick();
    expect(name?.name.value).toBe("");
    scope.stop();
  });

  it("保存領域が読めなくても例外にせず、空の名前として扱う", async () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const teamCode = ref<string | null>(null);
    const scope = effectScope();
    const name = scope.run(() => useTeamName(teamCode, createTeamNameStore(storage)));
    teamCode.value = "111111";
    await nextTick();
    expect(name?.name.value).toBe("");
    scope.stop();
  });
});
