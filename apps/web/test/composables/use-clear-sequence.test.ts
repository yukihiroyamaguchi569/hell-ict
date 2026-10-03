import { gameCommandResponseSchema } from "@hell-ict/domain";
import type { GameStageId, PlayedStageId, TeamGameScene } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { computed, effectScope, nextTick, ref, shallowRef } from "vue";

import { clearEffectScene } from "../../src/app-view.js";
import {
  CLEAR_GRACE_MS,
  CLEAR_UNLOCK_MS,
  useClearSequence,
} from "../../src/composables/use-clear-sequence.js";
import type { SendOutcome } from "../../src/composables/use-game-session.js";
import type { StageModule } from "../../src/stages/stage-module.js";
import { FakeScheduler, flush, viewBody } from "../fakes.js";

const clearScene = (stage: PlayedStageId, next: GameStageId, handover = false): TeamGameScene => ({
  kind: "clear-sequence",
  stage,
  next,
  handover,
});

const DONE: SendOutcome = { kind: "not-ready" };

const setup = (
  initial: TeamGameScene | null,
  answer: () => Promise<SendOutcome> = async () => DONE,
) => {
  const scene = shallowRef<TeamGameScene | null>(initial);
  const scheduler = new FakeScheduler();
  const unlocks: PlayedStageId[] = [];
  const sent: { from: PlayedStageId; to: GameStageId }[] = [];
  const commandIds: string[] = [];
  let idSeq = 0;
  const scope = effectScope();
  const clear = scope.run(() =>
    useClearSequence({
      scene,
      scheduler,
      onUnlock: (stage) => {
        unlocks.push(stage);
      },
      newCommandId: () => `id-${String((idSeq += 1))}`,
      sendAdvance: (from, to, commandId) => {
        sent.push({ from, to });
        commandIds.push(commandId);
        return answer();
      },
    }),
  );
  if (clear === undefined) throw new Error("scope did not run");
  /** Presses next after the grace of the sheet that just opened. */
  const pressAfterGrace = (): void => {
    scheduler.advanceBy(CLEAR_GRACE_MS);
    clear.next();
  };
  return { scene, scheduler, unlocks, sent, commandIds, clear, scope, pressAfterGrace };
};

describe("useClearSequence: 段の送り", () => {
  it("クリア演出の場面なら①から始まり、①の効果音を1回だけ鳴らす", () => {
    const { clear, unlocks } = setup(clearScene("s3", "s4"));
    expect(clear.step.value).toBe("unlock");
    expect(clear.stage.value).toBe("s3");
    expect(unlocks).toEqual(["s3"]);
  });

  it("①は押しても進まず、ちょうど 1900ms で②へ自動で送る", () => {
    const { clear, scheduler } = setup(clearScene("s3", "s4"));
    expect(CLEAR_UNLOCK_MS).toBe(1_900);
    clear.next();
    expect(clear.step.value).toBe("unlock");
    scheduler.advanceBy(CLEAR_UNLOCK_MS - 1);
    expect(clear.step.value).toBe("unlock");
    scheduler.advanceBy(1);
    expect(clear.step.value).toBe("field");
  });

  it("②→③→ advance（交代の案内が無いステージ）", async () => {
    const { clear, scheduler, sent, pressAfterGrace } = setup(clearScene("s3", "s4"));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    expect(clear.step.value).toBe("exec");
    expect(sent).toEqual([]);
    pressAfterGrace();
    await flush();
    expect(sent).toEqual([{ from: "s3", to: "s4" }]);
  });

  it("交代の案内があるステージは③の次に④を挟み、④を閉じてから advance", async () => {
    const { clear, scheduler, sent, pressAfterGrace } = setup(clearScene("s2", "s3", true));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    expect(clear.step.value).toBe("handover");
    expect(sent).toEqual([]);
    pressAfterGrace();
    await flush();
    expect(sent).toEqual([{ from: "s2", to: "s3" }]);
  });

  it("②は開いてすぐ押せる（連打の猶予は③④だけ）", () => {
    const { clear, scheduler } = setup(clearScene("s1", "s2"));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    expect(clear.step.value).toBe("exec");
  });

  it("③④は開いて 400ms 未満の押下を吸う（②を閉じた連打で読まずに閉じない）", async () => {
    const { clear, scheduler, sent } = setup(clearScene("s4", "s5", true));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    clear.next();
    scheduler.advanceBy(CLEAR_GRACE_MS - 1);
    clear.next();
    expect(clear.step.value).toBe("exec");
    scheduler.advanceBy(1);
    clear.next();
    expect(clear.step.value).toBe("handover");
    clear.next();
    scheduler.advanceBy(CLEAR_GRACE_MS - 1);
    clear.next();
    await flush();
    expect(sent).toEqual([]);
    scheduler.advanceBy(1);
    clear.next();
    await flush();
    expect(sent).toEqual([{ from: "s4", to: "s5" }]);
  });
});

describe("useClearSequence: advance はちょうど1回", () => {
  it("最後の段を何度押しても、返事を待つ間も、送るのは1回", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const pending = new Promise<SendOutcome>((resolve) => {
      release = resolve;
    });
    const { clear, scheduler, sent, pressAfterGrace } = setup(
      clearScene("s6", "final"),
      () => pending,
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    expect(clear.sending.value).toBe(true);
    clear.next();
    clear.next();
    release({ kind: "not-ready" });
    await flush();
    clear.next();
    await flush();
    expect(sent).toEqual([{ from: "s6", to: "final" }]);
    expect(clear.sending.value).toBe(false);
  });

  it("答えが届いた（applied・rejected・duplicate）後は、同じ演出から二度と送らない", async () => {
    const response = gameCommandResponseSchema.parse({
      status: "rejected",
      reason: "stage-mismatch",
      judgement: null,
      ...viewBody(5),
    });
    const { clear, scheduler, sent, pressAfterGrace } = setup(clearScene("s5", "s6"), async () => ({
      kind: "done",
      response,
    }));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    await flush();
    clear.next();
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("届かなかった（unavailable・failed）ときだけ、もう一度押して送り直せる", async () => {
    const outcomes: SendOutcome[] = [
      { kind: "unavailable" },
      { kind: "failed" },
      { kind: "stale" },
    ];
    const { clear, scheduler, sent, pressAfterGrace } = setup(
      clearScene("s3", "s4"),
      async () => outcomes.shift() ?? DONE,
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    await flush();
    expect(clear.step.value).toBe("exec");
    clear.next();
    await flush();
    clear.next();
    await flush();
    // stale は送り直さない（古いタブから書かない）。
    clear.next();
    await flush();
    expect(sent).toHaveLength(3);
  });

  it("押し直しは最初と同じ commandId で送る（適用済みなら duplicate で最初の結果が返る）", async () => {
    const outcomes: SendOutcome[] = [{ kind: "unavailable" }, { kind: "failed" }];
    const { clear, scheduler, commandIds, pressAfterGrace } = setup(
      clearScene("s2", "s3", true),
      async () => outcomes.shift() ?? DONE,
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    pressAfterGrace();
    await flush();
    clear.next();
    await flush();
    clear.next();
    await flush();
    expect(commandIds).toEqual(["id-1", "id-1", "id-1"]);
  });

  it("別のクリアの演出になったら、新しい commandId を使う", async () => {
    const { clear, scene, scheduler, commandIds, pressAfterGrace } = setup(
      clearScene("s3", "s4"),
      async () => ({ kind: "unavailable" }),
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    await flush();
    scene.value = clearScene("s4", "s5");
    await nextTick();
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    await flush();
    expect(commandIds).toEqual(["id-1", "id-2"]);
  });

  it("advance が通って場面が次のステージへ移ったら、演出を畳む", async () => {
    const { clear, scene, scheduler, pressAfterGrace } = setup(clearScene("s3", "s4"));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    await flush();
    scene.value = { kind: "stage", stage: "s4" };
    await nextTick();
    expect(clear.step.value).toBeNull();
    expect(clear.stage.value).toBeNull();
    expect(scheduler.pending).toBe(0);
  });
});

describe("useClearSequence: 再読み込み・取り直し", () => {
  it("再読み込み相当（作り直し）なら、途中の段からではなく①からやり直す", () => {
    const first = setup(clearScene("s2", "s3", true));
    first.scheduler.advanceBy(CLEAR_UNLOCK_MS);
    first.clear.next();
    expect(first.clear.step.value).toBe("exec");
    first.scope.stop();

    const reloaded = setup(clearScene("s2", "s3", true));
    expect(reloaded.clear.step.value).toBe("unlock");
    expect(reloaded.unlocks).toEqual(["s2"]);
  });

  it("演出中に同じクリアの状態を取り直しても、段は戻らず音も鳴り直さない", async () => {
    const { clear, scene, scheduler, unlocks } = setup(clearScene("s2", "s3", true));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    scene.value = clearScene("s2", "s3", true);
    await nextTick();
    expect(clear.step.value).toBe("exec");
    expect(unlocks).toEqual(["s2"]);
  });

  it("送信中に同じクリアを取り直しても二重に送らない", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const pending = new Promise<SendOutcome>((resolve) => {
      release = resolve;
    });
    const { clear, scene, scheduler, sent, pressAfterGrace } = setup(
      clearScene("s1", "s2"),
      () => pending,
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    scene.value = clearScene("s1", "s2");
    await nextTick();
    clear.next();
    release({ kind: "unavailable" });
    await flush();
    expect(sent).toHaveLength(1);
    expect(clear.step.value).toBe("exec");
  });

  it("クリア演出でない場面では何も出さず、何も送らない", () => {
    for (const scene of [
      null,
      { kind: "welcome" },
      { kind: "inbox" },
      { kind: "stage", stage: "s2" },
      { kind: "penalty", stage: "s3" },
      { kind: "final" },
    ] as const satisfies readonly (TeamGameScene | null)[]) {
      const { clear, sent, unlocks, scheduler } = setup(scene);
      clear.next();
      scheduler.advanceBy(10_000);
      clear.next();
      expect(clear.step.value).toBeNull();
      expect(sent).toEqual([]);
      expect(unlocks).toEqual([]);
    }
  });

  it("演出の途中で別のクリアに変わったら、そのクリアの①からやり直す", async () => {
    const { clear, scene, scheduler, unlocks } = setup(clearScene("s3", "s4"));
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    scene.value = clearScene("s4", "s5", true);
    await nextTick();
    expect(clear.step.value).toBe("unlock");
    expect(clear.stage.value).toBe("s4");
    expect(unlocks).toEqual(["s3", "s4"]);
  });

  it("前の演出の返事が遅れて届いても、今の演出の送信状態を変えない", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const first = new Promise<SendOutcome>((resolve) => {
      release = resolve;
    });
    const answers = [() => first, async () => DONE];
    const { clear, scene, scheduler, sent, pressAfterGrace } = setup(clearScene("s3", "s4"), () =>
      (answers.shift() ?? (async () => DONE))(),
    );
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    scene.value = clearScene("s4", "s5");
    await nextTick();
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    pressAfterGrace();
    expect(clear.sending.value).toBe(true);
    release({ kind: "unavailable" });
    await flush();
    expect(sent).toEqual([
      { from: "s3", to: "s4" },
      { from: "s4", to: "s5" },
    ]);
  });

  it("破棄したら残ったタイマーを止める", () => {
    const { scope, scheduler } = setup(clearScene("s3", "s4"));
    expect(scheduler.pending).toBe(1);
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});

describe("useClearSequence: ステージによる保留（clearEffectScene 経由）", () => {
  const BUILT: StageModule = { setup: () => ({ center: { render: () => null } }) };

  /** The frame's wiring: the scene reaches the effect only while the stage does not hold it. */
  const setupHeld = (module: StageModule | null, heldAtStart: boolean) => {
    const raw = shallowRef<TeamGameScene | null>(clearScene("s1", "s2"));
    const held = ref(heldAtStart);
    const scheduler = new FakeScheduler();
    const unlocks: PlayedStageId[] = [];
    const sent: PlayedStageId[] = [];
    const scope = effectScope();
    const clear = scope.run(() =>
      useClearSequence({
        scene: computed(() => clearEffectScene(raw.value, module, held.value)),
        scheduler,
        onUnlock: (stage) => {
          unlocks.push(stage);
        },
        newCommandId: () => "id-1",
        sendAdvance: async (from) => {
          sent.push(from);
          return DONE;
        },
      }),
    );
    if (clear === undefined) throw new Error("scope did not run");
    return { clear, held, scheduler, unlocks, sent };
  };

  it("保留中は演出が始まらず、効果音も鳴らさず、押しても advance を送らない", async () => {
    const { clear, scheduler, unlocks, sent } = setupHeld(BUILT, true);
    expect(clear.step.value).toBeNull();
    scheduler.advanceBy(CLEAR_UNLOCK_MS + CLEAR_GRACE_MS);
    clear.next();
    clear.next();
    await flush();
    expect([clear.step.value, unlocks, sent]).toEqual([null, [], []]);
  });

  it("保留が解けたら①から始まり、最後まで進めば advance を1回送る", async () => {
    const { clear, held, scheduler, unlocks, sent } = setupHeld(BUILT, true);
    held.value = false;
    await nextTick();
    expect(clear.step.value).toBe("unlock");
    expect(unlocks).toEqual(["s1"]);
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    scheduler.advanceBy(CLEAR_GRACE_MS);
    clear.next();
    await flush();
    expect(sent).toEqual(["s1"]);
  });

  it("保留しないステージ（口を持たない）は従来どおりすぐ始まる", () => {
    const { clear, unlocks } = setupHeld(BUILT, false);
    expect(clear.step.value).toBe("unlock");
    expect(unlocks).toEqual(["s1"]);
  });

  it("準備中のステージは保留が解けても演出を出さない", async () => {
    const { clear, held, unlocks } = setupHeld(null, true);
    held.value = false;
    await nextTick();
    expect([clear.step.value, unlocks]).toEqual([null, []]);
  });
});
