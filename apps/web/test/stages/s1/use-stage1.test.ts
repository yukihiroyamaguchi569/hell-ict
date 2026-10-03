import { stage1KarubeRound1Curt, stage1KarubeRound1Miss } from "@hell-ict/content";
import { DEADLINE_GRACE_MS, STAGE1_REPLY_LIMIT_MS } from "@hell-ict/domain";
import type { Stage1State } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { SendOutcome } from "../../../src/composables/use-game-session.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import {
  STAGE1_SETTLE_MAX_TRIES,
  STAGE1_SETTLE_RETRY_MS,
  useStage1,
} from "../../../src/stages/s1/use-stage1.js";
import { FakeKeyValueStorage, FakeScheduler, flush } from "../../fakes.js";
import { appliedWith, fakeSession, rejectedWith, stage1, T0, viewIn } from "./fake-session.js";
import type { Answer } from "./fake-session.js";

/** Every round's last mail missed: 23 s + 60 s + the grace + 1 ms after the round starts. */
const SETTLE_AT = T0 + 23_000 + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1;
const CAUSE_KEY = "hellVueStage1Cause:123456";

const mount = (
  s1: Stage1State | null = stage1(),
  answer: Answer = () => rejectedWith("round-not-over", viewIn(s1)),
  options: { now?: number; storage?: FakeKeyValueStorage } = {},
) => {
  const fake = fakeSession(viewIn(s1), answer);
  const serverNow = ref(options.now ?? T0);
  const scheduler = new FakeScheduler();
  const sessionStorage = options.storage ?? new FakeKeyValueStorage();
  const scope = effectScope();
  const played: string[] = [];
  const stage = scope.run(() =>
    useStage1({
      session: fake.session,
      serverNow,
      sessionStorage,
      scheduler,
      mail: useMailSelection(),
      sfx: {
        play: (name) => {
          played.push(name);
        },
      },
      karubeRead: ref(new Set<string>()),
      teamName: ref(""),
    }),
  );
  if (stage === undefined) throw new Error("the scope did not run");
  return { ...fake, stage, serverNow, scheduler, sessionStorage, scope, played };
};

const tick = async (serverNow: { value: number }, ms: number): Promise<void> => {
  serverNow.value = ms;
  await nextTick();
  await flush();
};

describe("useStage1: s1.settle", () => {
  it("締切の 1ms 前は送らず、ちょうどで1回だけ送る", async () => {
    const { serverNow, types } = mount(stage1(), () =>
      appliedWith(viewIn(stage1({ status: { phase: "round-result", failure: "round1" } }))),
    );
    await tick(serverNow, SETTLE_AT - 1);
    expect(types()).toEqual([]);
    await tick(serverNow, SETTLE_AT);
    await tick(serverNow, SETTLE_AT + 250);
    expect(types()).toEqual(["s1.settle"]);
  });

  it("再読み込みで締切を過ぎていれば、すぐに1回だけ送る", async () => {
    const { serverNow, types } = mount(
      stage1(),
      () => appliedWith(viewIn(stage1({ status: { phase: "round-result", failure: "round1" } }))),
      { now: SETTLE_AT + 30_000 },
    );
    await flush();
    await tick(serverNow, SETTLE_AT + 30_250);
    expect(types()).toEqual(["s1.settle"]);
  });

  it("サーバがまだと言ったら、少し待ってから聞き直す（上限つき）", async () => {
    const { serverNow, scheduler, types } = mount();
    await tick(serverNow, SETTLE_AT);
    expect(types()).toEqual(["s1.settle"]);
    for (let i = 1; i < STAGE1_SETTLE_MAX_TRIES + 3; i += 1) {
      scheduler.advanceBy(STAGE1_SETTLE_RETRY_MS);
      await tick(serverNow, SETTLE_AT + i * STAGE1_SETTLE_RETRY_MS);
    }
    expect(types()).toHaveLength(STAGE1_SETTLE_MAX_TRIES);
  });

  it("結果窓の間・クリア後・開始前は送らない（禁止遷移）", async () => {
    for (const s1 of [
      stage1({ status: { phase: "round-result", failure: "round1" } }),
      stage1({
        status: { phase: "cleared", result: "manual" },
        doneIds: ["m1", "m2", "m3", "m4", "m8"],
      }),
      null,
    ]) {
      const { serverNow, types } = mount(s1);
      await tick(serverNow, SETTLE_AT + 60_000);
      expect(types()).toEqual([]);
    }
  });
});

describe("useStage1: ボタン", () => {
  const live = { now: T0 + 1_000 };

  it("空の返信は送らない", async () => {
    const { stage, sent } = mount(stage1(), undefined, live);
    await expect(stage.reply("m1", "  \n ")).resolves.toEqual({ kind: "empty" });
    await expect(stage.replyToMemo("")).resolves.toEqual({ kind: "empty" });
    expect(sent).toEqual([]);
  });

  it("届いていない・時間切れのメールには送らない", async () => {
    const { stage, sent, serverNow } = mount(stage1(), undefined, live);
    await expect(stage.reply("m8", "よろしくお願いします")).resolves.toEqual({ kind: "closed" });
    serverNow.value = T0 + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1;
    await expect(stage.reply("m1", "よろしくお願いします")).resolves.toEqual({ kind: "closed" });
    await expect(stage.replyToMemo("ありがとうございます")).resolves.toEqual({ kind: "closed" });
    expect(sent).toEqual([]);
  });

  it("届いたメールへの返信を送り、答えが来るまで同じメールへは二重に送らない", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const s1 = stage1();
    const { stage, sent } = mount(
      s1,
      () =>
        new Promise<SendOutcome>((resolve) => {
          release = resolve;
        }),
      live,
    );
    const first = stage.reply("m1", "よろしくお願いします");
    await expect(stage.reply("m1", "よろしくお願いします")).resolves.toEqual({ kind: "closed" });
    release(appliedWith(viewIn(stage1({ doneIds: ["m1"] }))));
    await expect(first).resolves.toMatchObject({ kind: "sent" });
    expect(sent).toEqual([{ type: "s1.reply", mailId: "m1", text: "よろしくお願いします" }]);
  });

  it("引き継ぎメモへの返信は s1.memo-reply", async () => {
    const { stage, sent } = mount(stage1(), () => appliedWith(viewIn(stage1())), live);
    await stage.replyToMemo("ありがとうございます");
    expect(sent).toEqual([{ type: "s1.memo-reply", text: "ありがとうございます" }]);
  });

  it("次のラウンドへは結果窓のときだけ、開始は未開始のときだけ", async () => {
    const playing = mount(stage1(), undefined, live);
    await expect(playing.stage.nextRound()).resolves.toEqual({ kind: "closed" });
    await expect(playing.stage.start()).resolves.toEqual({ kind: "closed" });
    expect(playing.sent).toEqual([]);

    const window = mount(stage1({ status: { phase: "round-result", failure: "round1" } }), () =>
      appliedWith(viewIn(stage1({ round: 2, roundStartedAt: T0 + 90_000 }))),
    );
    await window.stage.nextRound();
    const notStarted = mount(null, () => appliedWith(viewIn(stage1())));
    await notStarted.stage.start();
    expect([...window.types(), ...notStarted.types()]).toEqual(["s1.next-round", "s1.start"]);
  });
});

describe("useStage1: メール着弾の効果音", () => {
  it("新しく届いた1通ごとに decision1 を1回だけ鳴らす（音量は use-sfx の既定）", async () => {
    const { serverNow, played } = mount(stage1(), undefined, { now: T0 + 1_000 });
    expect(played).toEqual([]);
    await tick(serverNow, T0 + 4_999);
    expect(played).toEqual([]);
    await tick(serverNow, T0 + 5_000);
    await tick(serverNow, T0 + 5_250);
    expect(played).toEqual(["decision1"]);
    await tick(serverNow, T0 + 23_000);
    expect(played).toEqual(["decision1", "decision1", "decision1", "decision1"]);
  });

  it("開始の答えで1通目が届けば鳴らす", async () => {
    const { stage, played } = mount(null, () => appliedWith(viewIn(stage1())));
    expect(played).toEqual([]);
    await stage.start();
    await nextTick();
    expect(played).toEqual(["decision1"]);
  });

  it("再読み込み直後に届いていたメールでは鳴らさない", async () => {
    const { serverNow, played } = mount(stage1(), undefined, { now: T0 + 30_000 });
    await flush();
    await tick(serverNow, T0 + 30_250);
    expect(played).toEqual([]);
  });

  it("時計が遅れた PC で再読み込みしても、時差の補正で既に届いていたメールは鳴らさない", async () => {
    // Built on the PC's own time (10 minutes behind), then redrawn on the server's.
    const { serverNow, played } = mount(stage1(), undefined, { now: T0 - 600_000 });
    await flush();
    await tick(serverNow, T0 + 12_000);
    expect(played).toEqual([]);
    await tick(serverNow, T0 + 17_000);
    expect(played).toEqual(["decision1"]);
  });

  it("着弾の後に時計が戻って再び進んでも、同じメールは二度鳴らさない", async () => {
    const { serverNow, played } = mount(stage1(), undefined, { now: T0 + 1_000 });
    await tick(serverNow, T0 + 1_250);
    await tick(serverNow, T0 + 5_000);
    expect(played).toEqual(["decision1"]);
    await tick(serverNow, T0 + 4_000);
    await tick(serverNow, T0 + 5_000);
    await tick(serverNow, T0 + 5_250);
    expect(played).toEqual(["decision1"]);
  });

  it("R3 のやり直しで同じメールがまた届けば鳴らす", async () => {
    const r3 = stage1({
      round: 3,
      r3Try: 1,
      status: { phase: "round-result", failure: "round3" },
    });
    const again = stage1({ round: 3, r3Try: 2, roundStartedAt: T0 + 120_000 });
    const { stage, serverNow, played } = mount(r3, () => appliedWith(viewIn(again)), {
      now: T0 + 119_750,
    });
    await tick(serverNow, T0 + 120_000);
    expect(played).toEqual([]);
    await stage.nextRound();
    await nextTick();
    expect(played).toEqual(["decision1"]);
  });
});

describe("useStage1: R1 の原因と苅部さん", () => {
  const r1Failed = (curt: boolean) =>
    stage1({
      doneIds: curt ? ["m1", "m2", "m3", "m4", "m8"] : [],
      curt: curt
        ? (["m1", "m2", "m3", "m4", "m8"] as const).map((mailId) => ({ mailId, reply: "了解" }))
        : [],
      status: { phase: "round-result", failure: "round1" },
    });

  it("結果窓が出た時点で原因を記録し、R2 ではそれで出し分ける", async () => {
    const { stage, view, sessionStorage } = mount(r1Failed(true), undefined, {
      now: SETTLE_AT,
    });
    expect(JSON.parse(sessionStorage.values.get(CAUSE_KEY) ?? "null")).toEqual({
      stageStartedAt: T0,
      cause: "curt",
    });
    view.value = viewIn(stage1({ round: 2, roundStartedAt: T0 + 90_000 }));
    await nextTick();
    expect(stage.karubeCalls.value.map((c) => c.lines)).toEqual([stage1KarubeRound1Curt]);
  });

  // 回帰（Sol 指摘）: 原因は画面の推定時刻ではなく、サーバの状態だけで決める。
  it("推定時刻が締切より前にずれていても、返していないメールは時間切れとして数える", () => {
    const r1 = stage1({
      doneIds: ["m1"],
      curt: [{ mailId: "m1", reply: "了解" }],
      status: { phase: "round-result", failure: "round1" },
    });
    // 画面の時刻は最後の1通の締切より前（未返信の4通がまだ live に見える）。
    const { sessionStorage } = mount(r1, undefined, { now: T0 + 30_000 });
    expect(JSON.parse(sessionStorage.values.get(CAUSE_KEY) ?? "null")).toEqual({
      stageStartedAt: T0,
      cause: "missed",
    });
  });

  it("再読み込みで R2 から始まっても記録から出し分ける", () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(CAUSE_KEY, JSON.stringify({ stageStartedAt: T0, cause: "curt" }));
    const { stage } = mount(stage1({ round: 2 }), undefined, { storage });
    expect(stage.karubeCalls.value.map((c) => c.lines)).toEqual([stage1KarubeRound1Curt]);
  });

  it.each([
    ["記録が無い", null],
    ["壊れている", "{not json"],
    ["形が違う", JSON.stringify({ cause: "curt" })],
    ["前のゲーム（リセット前）のもの", JSON.stringify({ stageStartedAt: T0 - 1, cause: "curt" })],
  ])("%s ときは時間切れの台詞", (_label, saved) => {
    const storage = new FakeKeyValueStorage();
    if (saved !== null) storage.values.set(CAUSE_KEY, saved);
    const { stage } = mount(stage1({ round: 2 }), undefined, { storage });
    expect(stage.karubeCalls.value.map((c) => c.lines)).toEqual([stage1KarubeRound1Miss]);
  });

  it("保存が使えなくても、この画面の中では原因を覚えている", async () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const { stage, view } = mount(r1Failed(true), undefined, { now: SETTLE_AT, storage });
    view.value = viewIn(stage1({ round: 2, roundStartedAt: T0 + 90_000 }));
    await nextTick();
    expect(stage.karubeCalls.value.map((c) => c.lines)).toEqual([stage1KarubeRound1Curt]);
  });

  it("別のステージの状態では何も返さない", () => {
    const fake = mount(stage1());
    fake.view.value = viewIn(stage1(), "s2");
    expect(fake.stage.state.value).toBeNull();
    expect(fake.stage.karubeCalls.value).toEqual([]);
    expect(fake.stage.rows.value).toEqual([]);
  });
});
