import { finalLabels } from "@hell-ict/content";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { ACTIVITY_RETRY_DELAYS_MS, createActivityApi } from "../../../src/api/activity-api.js";
import { createGameApi } from "../../../src/api/game-api.js";
import { createGameSession } from "../../../src/composables/use-game-session.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import type { HttpRequest, HttpResponse } from "../../../src/ports.js";
import {
  BOARD_LIGHT_MS,
  EPILOGUE_GRACE_MS,
  RELAY_AFTER_LINE_MS,
  RELAY_ON_RETURN_MS,
  TILE_COUNT,
} from "../../../src/stages/final/final-view.js";
import { CONFETTI_CLEAR_MS } from "../../../src/stages/final/goal-view.js";
import { useFinal } from "../../../src/stages/final/use-final.js";
import type { StageContext } from "../../../src/stages/stage-module.js";
import {
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  START_MS,
  unavailable,
  viewBody,
} from "../../fakes.js";

const ENTERED = new Date(START_MS + 600_000).toISOString();
const INTRO_KEY = "hellVueFinalIntro:123456";
const RECORD_KEY = "hellVueFinal:123456";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Written, and the activity log has it. */
const WRITTEN = { enteredAt: ENTERED, line: "名前を消す。", ended: false, pending: null };
const CLIENT_AT = new Date(START_MS + 700_000).toISOString();

const finalView = () => {
  const base = viewBody(7);
  const game = { ...base.state.game, stage: "final" };
  return { ...base, state: { ...base.state, game, enteredAt: { final: ENTERED } } };
};

interface Options {
  /** The `enteredAt` the intro was read for (`true`: this entry's). */
  intro?: true | string;
  /** What `hellVueFinal` holds: a string as it is (a broken value), anything else as JSON. */
  record?: object | string;
  activity?: (request: HttpRequest) => HttpResponse;
  failingStorage?: boolean;
}

const seededStorage = (options: Options): FakeKeyValueStorage => {
  const storage = new FakeKeyValueStorage();
  const { intro, record } = options;
  if (intro !== undefined) {
    storage.setItem(INTRO_KEY, JSON.stringify({ enteredAt: intro === true ? ENTERED : intro }));
  }
  if (record !== undefined) {
    storage.setItem(RECORD_KEY, typeof record === "string" ? record : JSON.stringify(record));
  }
  storage.failing = options.failingStorage === true;
  return storage;
};

const setup = async (options: Options = {}) => {
  const storage = seededStorage(options);
  const scheduler = new FakeScheduler();
  const session = createGameSession({
    api: createGameApi(
      new FakeHttp((request) =>
        request.path === "/api/session" ? ok(sessionBody("123456", 3)) : ok(finalView()),
      ),
    ),
    clock: new FakeClock(new Date(START_MS)),
    ids: new FakeIdGenerator([ID(1), ID(2), ID(3)]),
    storage: new FakeKeyValueStorage(),
    scheduler,
    resume: new FakeResumeSignal(),
  });
  await session.join("123456");
  const activityHttp = new FakeHttp(options.activity ?? (() => ok({ ok: true })));
  const context: StageContext = {
    session,
    serverNow: ref(START_MS + 700_000),
    sessionStorage: storage,
    scheduler,
    mail: useMailSelection(),
    sfx: { play: () => undefined },
    karubeRead: ref(new Set<string>()),
    teamName: ref("チームA"),
  };
  const scope = effectScope();
  const final = scope.run(() => useFinal(context, createActivityApi(activityHttp)));
  if (final === undefined) throw new Error("the scope did not run");
  const settle = async (): Promise<void> => {
    await flush();
    await nextTick();
  };
  const kept = (key: string): unknown => JSON.parse(storage.getItem(key) ?? "null");
  return { final, session, scheduler, storage, activityHttp, scope, settle, kept };
};

/** Through the goal and the epilogue, lights every tile and writes `text` in the piece. */
const write = async (s: Awaited<ReturnType<typeof setup>>, text: string): Promise<void> => {
  s.final.pressGoalNext();
  await s.settle();
  s.scheduler.advanceBy(EPILOGUE_GRACE_MS);
  s.final.pressEpilogueNext();
  await s.settle();
  for (let i = 0; i < TILE_COUNT; i += 1) {
    s.scheduler.advanceBy(BOARD_LIGHT_MS);
    await s.settle();
  }
  s.final.draft.value = text;
  s.final.writeLine();
  await s.settle();
};

describe("ゴールとエピローグ", () => {
  it("初めての入場はゴールから。エピローグは開いて400ms未満の押下を捨て、押せば intro 済みを保存", async () => {
    const s = await setup();
    expect(s.final.phase.value).toEqual({ kind: "goal" });
    expect(s.final.goalTitle.value).toBe("チームA　ゴール");
    s.final.pressEpilogueNext();
    s.final.pressGoalNext();
    await s.settle();
    s.scheduler.advanceBy(EPILOGUE_GRACE_MS - 1);
    s.final.pressEpilogueNext();
    expect(s.final.phase.value).toEqual({ kind: "epilogue" });
    expect(s.storage.getItem(INTRO_KEY)).toBeNull();
    s.scheduler.advanceBy(1);
    s.final.pressEpilogueNext();
    await s.settle();
    expect(s.final.phase.value).toEqual({ kind: "board", lit: 0 });
    expect(s.kept(INTRO_KEY)).toEqual({ enteredAt: ENTERED });
  });

  it("紙吹雪はゴールが出てから3.4秒で、アニメーションの終わりを待たずに消える", async () => {
    const s = await setup();
    expect(s.final.confetti.value).toBe(true);
    s.scheduler.advanceBy(CONFETTI_CLEAR_MS - 1);
    expect(s.final.confetti.value).toBe(true);
    s.scheduler.advanceBy(1);
    expect(s.final.confetti.value).toBe(false);
    expect(s.final.phase.value).toEqual({ kind: "goal" });
  });

  it("ゴールを離れれば紙吹雪は無く、ステージを離れれば消すタイマーも残らない", async () => {
    const s = await setup();
    s.final.pressGoalNext();
    await s.settle();
    expect(s.final.confetti.value).toBe(false);
    s.scope.stop();
    expect(s.scheduler.pending).toBe(0);
  });

  it("intro 済みの再入場はボードからで、紙吹雪は出ない", async () => {
    const s = await setup({ intro: true });
    expect(s.final.phase.value).toEqual({ kind: "board", lit: 0 });
    expect(s.final.confetti.value).toBe(false);
  });

  it("別の enteredAt（GM リセット前）の intro 済みと一言は読まず、ゴールから", async () => {
    const before = "2026-01-01T00:00:00.000Z";
    const s = await setup({
      intro: before,
      record: { ...WRITTEN, enteredAt: before, ended: true },
    });
    expect(s.final.phase.value).toEqual({ kind: "goal" });
    expect(s.final.line.value).toBeNull();
  });
});

describe("振り返りボードと一言", () => {
  it("intro 済みの再入場は暗いボードから。400ms間隔で1枚ずつ点き、全点灯でピースが開く", async () => {
    const s = await setup({ intro: true });
    s.final.draft.value = "早すぎる";
    s.final.writeLine();
    expect(s.final.line.value).toBeNull();
    s.scheduler.advanceBy(BOARD_LIGHT_MS - 1);
    expect(s.final.phase.value).toEqual({ kind: "board", lit: 0 });
    for (let i = 1; i <= TILE_COUNT; i += 1) {
      s.scheduler.advanceBy(i === 1 ? 1 : BOARD_LIGHT_MS);
      await s.settle();
      expect(s.final.phase.value).toEqual({ kind: "board", lit: i });
    }
    expect(s.final.pieceOpen.value).toBe(true);
    expect(s.scheduler.pending).toBe(0);
  });

  it("空欄は拒否して保存も送信もしない。記すと保存して submit.final を1回だけ送り、1100ms後にリレー", async () => {
    const s = await setup();
    await write(s, " 　");
    expect(s.final.note.value).toBe(finalLabels.lineEmpty);
    expect(s.final.line.value).toBeNull();
    expect(s.storage.getItem(RECORD_KEY)).toBeNull();
    expect(s.activityHttp.requests).toEqual([]);
    s.final.draft.value = "  名前を消す。 ";
    s.final.writeLine();
    s.final.writeLine();
    await s.settle();
    expect(s.final.note.value).toBe("");
    expect(s.kept(RECORD_KEY)).toEqual(WRITTEN);
    expect(s.activityHttp.requests).toEqual([
      {
        method: "POST",
        path: "/api/teams/123456/activity",
        body: {
          commandId: ID(1),
          kind: "submit.final",
          view: "final",
          text: "名前を消す。",
          clientAt: CLIENT_AT,
          generation: 3,
        },
      },
    ]);
    s.scheduler.advanceBy(RELAY_AFTER_LINE_MS - 1);
    expect(s.final.phase.value.kind).toBe("board");
    s.scheduler.advanceBy(1);
    expect(s.final.phase.value).toEqual({ kind: "relay", step: 0 });
  });

  it("送信に失敗しても進み、同じ commandId で送り直す。400 では諦める", async () => {
    const answers = [unavailable(), { status: 400, body: { message: "x" } }];
    const s = await setup({ activity: () => answers.shift() ?? ok({ ok: true }) });
    await write(s, "一言");
    s.scheduler.advanceBy(RELAY_AFTER_LINE_MS);
    expect(s.final.phase.value).toEqual({ kind: "relay", step: 0 });
    for (let i = 0; i < 2; i += 1) {
      s.scheduler.advanceBy(60_000);
      await s.settle();
    }
    const sameId = expect.objectContaining({ commandId: ID(1), text: "一言" });
    expect(s.activityHttp.requests.map((r) => r.body)).toEqual([sameId, sameId]);
  });

  it("切断が続けば決めた回数で止める（保存もできなくても感謝状まで進む）。ステージを離れたらもう送らない", async () => {
    const offline = (): never => {
      throw new Error("offline");
    };
    const lost = await setup({ activity: offline, failingStorage: true });
    await write(lost, "一言");
    for (const delay of [...ACTIVITY_RETRY_DELAYS_MS, 60_000]) {
      lost.scheduler.advanceBy(delay);
      await lost.settle();
    }
    expect(lost.activityHttp.requests).toHaveLength(1 + ACTIVITY_RETRY_DELAYS_MS.length);
    for (let i = 0; i < 3; i += 1) lost.final.pressRelayNext();
    expect(lost.final.phase.value).toEqual({ kind: "handover" });

    const left = await setup({ activity: offline });
    await write(left, "一言");
    left.scope.stop();
    left.scheduler.advanceBy(60_000);
    await left.settle();
    expect(left.activityHttp.requests).toHaveLength(1);
  });

  it("121字は拒否して、保存も送信もしない", async () => {
    const s = await setup();
    await write(s, "あ".repeat(121));
    expect(s.final.note.value).toBe(finalLabels.lineTooLong);
    expect(s.final.line.value).toBeNull();
    expect(s.final.pieceOpen.value).toBe(true);
    expect(s.storage.getItem(RECORD_KEY)).toBeNull();
    expect(s.activityHttp.requests).toEqual([]);
  });

  it("409 stale-generation（GM リセット後の古いタブ）は画面を stale にし、送り直さない", async () => {
    const s = await setup({
      activity: () => ({
        status: 409,
        body: { message: "古くなっています。", code: "stale-generation" },
      }),
    });
    await write(s, "一言");
    expect(s.session.status.value).toBe("stale");
    s.scheduler.advanceBy(60_000);
    await s.settle();
    expect(s.activityHttp.requests).toHaveLength(1);
  });

  it("429 は Retry-After の秒数だけ待って同じ commandId で送り直す", async () => {
    const answers: HttpResponse[] = [{ status: 429, body: { message: "x" }, retryAfter: "30" }];
    const s = await setup({ activity: () => answers.shift() ?? ok({ ok: true }) });
    await write(s, "一言");
    s.scheduler.advanceBy(ACTIVITY_RETRY_DELAYS_MS[2]);
    await s.settle();
    expect(s.activityHttp.requests).toHaveLength(1);
    s.scheduler.advanceBy(30_000 - ACTIVITY_RETRY_DELAYS_MS[2]);
    await s.settle();
    const sameId = expect.objectContaining({ commandId: ID(1) });
    expect(s.activityHttp.requests.map((r) => r.body)).toEqual([sameId, sameId]);
  });

  it("届かないまま再読み込みしても、未送信の一言を同じ commandId と時刻で送り直し、届いたら送信済みにする", async () => {
    const offline = (): never => {
      throw new Error("offline");
    };
    const first = await setup({ activity: offline });
    await write(first, "一言");
    const pending = { commandId: ID(1), clientAt: CLIENT_AT };
    expect(first.kept(RECORD_KEY)).toEqual({ ...WRITTEN, line: "一言", pending });

    const reloaded = await setup({ record: first.kept(RECORD_KEY) ?? {} });
    await reloaded.settle();
    expect(reloaded.activityHttp.requests.map((r) => r.body)).toEqual([
      expect.objectContaining({ commandId: ID(1), clientAt: CLIENT_AT, text: "一言" }),
    ]);
    expect(reloaded.kept(RECORD_KEY)).toEqual({ ...WRITTEN, line: "一言" });
  });
});

describe("リレーと感謝状", () => {
  it("記してあって ended でない再入場は完成ボードから700ms後にリレー（送り直さない）→ 感謝状", async () => {
    const s = await setup({ record: WRITTEN });
    expect(s.final.phase.value).toEqual({ kind: "board", lit: TILE_COUNT });
    expect(s.final.pieceOpen.value).toBe(false);
    s.scheduler.advanceBy(RELAY_ON_RETURN_MS - 1);
    expect(s.final.phase.value.kind).toBe("board");
    s.scheduler.advanceBy(1);
    expect(s.final.phase.value).toEqual({ kind: "relay", step: 0 });
    expect(s.activityHttp.requests).toEqual([]);
    // 背景クリックは最後の話者で止まり、［感謝状を受け取る］で ended を保存する。
    for (let i = 0; i < 3; i += 1) s.final.pressRelayBackdrop();
    expect(s.final.phase.value).toEqual({ kind: "relay", step: 2 });
    s.final.pressRelayNext();
    await s.settle();
    expect(s.final.phase.value).toEqual({ kind: "handover" });
    expect(s.kept(RECORD_KEY)).toEqual({ ...WRITTEN, ended: true });
    expect(s.final.address.value).toBe("チームA　御中");
    expect(s.final.quote.value).toBe("「名前を消す。」");
  });

  it("ended の再入場は感謝状を直接出す。［最初に戻る］は記録を消さずに rest、進むと感謝状", async () => {
    const s = await setup({ record: { ...WRITTEN, ended: true } });
    expect(s.final.phase.value).toEqual({ kind: "handover" });
    s.scheduler.advanceBy(60_000);
    s.final.restart();
    await s.settle();
    expect(s.final.phase.value).toEqual({ kind: "rest" });
    expect(s.kept(RECORD_KEY)).toEqual({ ...WRITTEN, ended: true });
    s.final.resume();
    expect(s.final.phase.value).toEqual({ kind: "handover" });
  });
});

describe("壊れた保存", () => {
  it.each([
    ["JSON でない", "{not json"],
    ["一言が数値の", { ...WRITTEN, line: 42 }],
    ["一言の無い ended の", { ...WRITTEN, line: null, ended: true }],
  ])("%s保存は捨ててゴールから", async (_, record) => {
    const s = await setup({ record });
    expect(s.final.phase.value).toEqual({ kind: "goal" });
    expect(s.storage.getItem(RECORD_KEY)).toBeNull();
  });
});
