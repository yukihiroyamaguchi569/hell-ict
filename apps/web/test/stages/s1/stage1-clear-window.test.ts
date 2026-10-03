import { gameViewResponseSchema, teamGameScene } from "@hell-ict/domain";
import type { GameStageId, Stage1State } from "@hell-ict/domain";
import { FakeClock } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { computed, effectScope, nextTick, ref } from "vue";

import { clearEffectScene } from "../../../src/app-view.js";
import {
  CLEAR_GRACE_MS,
  CLEAR_UNLOCK_MS,
  useClearSequence,
} from "../../../src/composables/use-clear-sequence.js";
import type { GameView } from "../../../src/composables/use-game-session.js";
import type { SfxName } from "../../../src/composables/use-sfx.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import { setupStage1 } from "../../../src/stages/s1/index.js";
import type { Stage1Screen } from "../../../src/stages/s1/use-stage1-screen.js";
import type { StageModule, StageRegistry } from "../../../src/stages/stage-module.js";
import { useStageFrame } from "../../../src/stages/use-stage-frame.js";
import { FakeHttp, FakeKeyValueStorage, FakeScheduler, flush, unavailable } from "../../fakes.js";
import { appliedWith, fakeSession, stage1, T0, viewIn } from "./fake-session.js";

/*
 * Stage 1's clear through the frame, as App.vue wires it: the result window holds the clear
 * effect back, and ［確認した（次へ）］ lets it start from ①.
 */

/** R1 answered in full and politely (the server's schema checks that a clear is a clean round). */
const CLEARED: Stage1State = {
  ...stage1(),
  doneIds: ["m1", "m2", "m3", "m4", "m8"],
  status: { phase: "cleared", result: "manual" },
};

/** The team's view in `stage` with Stage 1 cleared (the server writes `clearedAt` with the clear). */
const clearedView = (stage: GameStageId = "s1"): GameView => {
  const view = viewIn(CLEARED, stage);
  return gameViewResponseSchema.parse({
    ...view,
    state: {
      ...view.state,
      game: { ...view.state.game, clearedAt: { s1: new Date(T0 + 90_000).toISOString() } },
    },
  });
};

const registryWith = (s1: StageModule): StageRegistry => ({
  prologue: null,
  s1,
  s2: null,
  s3: null,
  s4: null,
  s5: null,
  s6: null,
  final: null,
});

/** App.vue's wiring of the frame and the clear effect, around a server that is at `initial`. */
const mount = (initial: GameView) => {
  const fake = fakeSession(initial, (command) =>
    appliedWith(command.type === "advance" ? clearedView("s2") : clearedView()),
  );
  const scheduler = new FakeScheduler();
  const played: SfxName[] = [];
  const unlocks: string[] = [];
  let screen: Stage1Screen | null = null;
  const module: StageModule = {
    setup: (context) => {
      const built = setupStage1(context, {
        http: new FakeHttp(() => unavailable()),
        clock: new FakeClock(new Date(T0)),
        clipboard: { writeText: () => Promise.resolve() },
      });
      screen = built.screen;
      return built.instance;
    },
  };
  const scope = effectScope();
  const wired = scope.run(() => {
    const frame = useStageFrame(
      () => fake.view.value?.state.game.stage ?? null,
      registryWith(module),
      {
        session: fake.session,
        serverNow: ref(T0 + 90_000),
        sessionStorage: new FakeKeyValueStorage(),
        scheduler,
        mail: useMailSelection(),
        sfx: {
          play: (name) => {
            played.push(name);
          },
        },
        karubeRead: ref(new Set<string>()),
        teamName: ref(""),
      },
    );
    const clear = useClearSequence({
      scene: computed(() =>
        clearEffectScene(
          fake.view.value === null ? null : teamGameScene(fake.view.value.state),
          frame.module.value,
          frame.clearHeld.value,
        ),
      ),
      scheduler,
      onUnlock: (stage) => {
        unlocks.push(stage);
      },
      newCommandId: () => fake.session.newCommandId(),
      sendAdvance: (from, to, commandId) =>
        fake.session.send({ type: "advance", from, to }, commandId),
    });
    return { frame, clear };
  });
  if (wired === undefined) throw new Error("the scope did not run");
  const pressed = (): Stage1Screen => {
    if (screen === null) throw new Error("Stage 1 was not built");
    return screen;
  };
  return { ...fake, ...wired, scheduler, played, unlocks, scope, screen: pressed };
};

/** Presses through ① → ② → ③ (Stage 1 asks for no change of seats). */
const playEffect = async (m: ReturnType<typeof mount>): Promise<void> => {
  m.scheduler.advanceBy(CLEAR_UNLOCK_MS);
  m.clear.next();
  m.scheduler.advanceBy(CLEAR_GRACE_MS);
  m.clear.next();
  m.clear.next();
  await flush();
};

describe("Stage 1 のクリア：結果窓が先、クリア演出は OK の後", () => {
  it("クリアした状態で入ると結果窓が出て success1 が1回鳴り、演出は始まらない", () => {
    const m = mount(viewIn(stage1()));
    expect(m.screen().clearWindow.value).toBeNull();
    m.view.value = clearedView();
    return nextTick().then(() => {
      expect(m.screen().clearWindow.value?.heading).toBe("受信トレイが落ち着きました");
      expect([m.frame.clearHeld.value, m.frame.overlayWanted.value]).toEqual([true, true]);
      // The clear and the hold arrive in the same tick: ① never started, not even for a frame.
      expect([m.clear.step.value, m.unlocks]).toEqual([null, []]);
      expect(m.played).toEqual(["success1"]);
    });
  });

  it("窓が出ている間は演出の段を押しても advance を送らない", async () => {
    const m = mount(clearedView());
    m.scheduler.advanceBy(CLEAR_UNLOCK_MS + CLEAR_GRACE_MS);
    m.clear.next();
    m.clear.next();
    await flush();
    expect(m.clear.step.value).toBeNull();
    expect(m.types()).not.toContain("advance");
  });

  it("［確認した（次へ）］で窓が閉じ、演出が①から始まり、最後まで進めて advance はちょうど1回", async () => {
    const m = mount(clearedView());
    m.screen().closeClearWindow();
    await nextTick();
    expect(m.screen().clearWindow.value).toBeNull();
    expect(m.frame.clearHeld.value).toBe(false);
    expect([m.clear.step.value, m.unlocks]).toEqual(["unlock", ["s1"]]);
    await playEffect(m);
    m.clear.next();
    await flush();
    expect(m.sent.filter((command) => command.type === "advance")).toEqual([
      { type: "advance", from: "s1", to: "s2" },
    ]);
    // The team moved on: Stage 1 is gone, and success1 did not sound again.
    expect(m.frame.instance.value).toBeNull();
    expect(m.played).toEqual(["success1"]);
  });

  it("OK を押したことは保存しない：再読み込み（作り直し）すると結果窓から出し直し、音も鳴る", async () => {
    const first = mount(clearedView());
    first.screen().closeClearWindow();
    await nextTick();
    expect(first.clear.step.value).toBe("unlock");
    first.scope.stop();

    const reloaded = mount(clearedView());
    expect(reloaded.screen().clearWindow.value).not.toBeNull();
    expect(reloaded.clear.step.value).toBeNull();
    expect(reloaded.played).toEqual(["success1"]);
    expect(reloaded.types()).not.toContain("advance");
  });

  it("失敗したラウンドの結果では保留しない（クリアの窓ではない）", () => {
    const m = mount(viewIn({ ...stage1(), status: { phase: "round-result", failure: "round1" } }));
    expect(m.screen().clearWindow.value).toBeNull();
    expect(m.frame.clearHeld.value).toBe(false);
    expect(m.played).toEqual([]);
  });
});
