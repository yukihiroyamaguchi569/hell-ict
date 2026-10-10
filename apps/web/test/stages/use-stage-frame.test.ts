import type { GameStageId } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { Ref } from "vue";

import { createGameApi } from "../../src/api/game-api.js";
import { createGameSession } from "../../src/composables/use-game-session.js";
import { useMailSelection } from "../../src/inbox/use-stage-inbox.js";
import type { StageFocus } from "../../src/shell/mission-bar-view.js";
import type { RightPane } from "../../src/shell/shell-view.js";
import type { StageContext, StageModule, StageRegistry } from "../../src/stages/stage-module.js";
import { useStageFrame } from "../../src/stages/use-stage-frame.js";
import {
  FakeGameServer,
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  START_MS,
} from "../fakes.js";

const context = (): StageContext => {
  const scheduler = new FakeScheduler();
  return {
    session: createGameSession({
      api: createGameApi(new FakeHttp(new FakeGameServer().handle)),
      clock: new FakeClock(new Date(START_MS)),
      ids: new FakeIdGenerator([]),
      storage: new FakeKeyValueStorage(),
      scheduler,
      resume: new FakeResumeSignal(),
    }),
    serverNow: ref(START_MS),
    sessionStorage: new FakeKeyValueStorage(),
    scheduler,
    mail: useMailSelection(),
    sfx: { play: () => undefined, tone: () => undefined },
    karubeRead: ref(new Set<string>()),
    chatPiiBlocks: ref(0),
    teamName: ref(""),
  };
};

/** A stage that records its lifecycle and exposes refs the test can move. */
const trackedStage = (name: string, log: string[]) => {
  const focus = ref<StageFocus>(null);
  const overlayWanted = ref(false);
  const rightPane = ref<RightPane | null>(null);
  const tick = ref(0);
  const module: StageModule = {
    setup: (given) => {
      log.push(`setup:${name}`);
      expect(given.serverNow.value).toBe(START_MS);
      // A watcher of the stage's own: it must stop with the stage.
      watch(tick, () => log.push(`tick:${name}`));
      onScopeDispose(() => log.push(`dispose:${name}`));
      return { center: { render: () => null }, focus, overlayWanted, rightPane };
    },
  };
  return { module, focus, overlayWanted, rightPane, tick };
};

const registryWith = (modules: Partial<Record<GameStageId, StageModule>>): StageRegistry => ({
  prologue: null,
  s1: null,
  s2: null,
  s3: null,
  s4: null,
  s5: null,
  s6: null,
  final: null,
  ...modules,
});

const mount = (stage: Ref<GameStageId | null>, registry: StageRegistry) => {
  const scope = effectScope();
  const frame = scope.run(() => useStageFrame(() => stage.value, registry, context()));
  if (frame === undefined) throw new Error("the scope did not run");
  return { frame, scope };
};

describe("useStageFrame", () => {
  it("登録の無いステージ（準備中）は何も組み立てない", () => {
    const { frame } = mount(ref<GameStageId | null>("s3"), registryWith({}));
    expect(frame.module.value).toBeNull();
    expect(frame.instance.value).toBeNull();
    expect(frame.focus.value).toBeNull();
    expect(frame.overlayWanted.value).toBe(false);
    expect(frame.rightOverride.value).toBeNull();
  });

  it("入ったステージを1回だけ組み立て、同じステージにいる間は組み立て直さない", async () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const stage = ref<GameStageId | null>("s1");
    const { frame } = mount(stage, registryWith({ s1: s1.module }));
    expect(frame.module.value).toBe(s1.module);
    expect(frame.instance.value).not.toBeNull();
    stage.value = "s1";
    await nextTick();
    expect(log).toEqual(["setup:s1"]);
  });

  it("ステージを出たら前のステージを破棄し（監視も止まる）、次のステージを組み立てる", async () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const s2 = trackedStage("s2", log);
    const stage = ref<GameStageId | null>("s1");
    const { frame } = mount(stage, registryWith({ s1: s1.module, s2: s2.module }));
    stage.value = "s2";
    await nextTick();
    expect(log).toEqual(["setup:s1", "dispose:s1", "setup:s2"]);
    s1.tick.value += 1;
    await nextTick();
    expect(log).not.toContain("tick:s1");
    expect(frame.module.value).toBe(s2.module);
  });

  it("未実装のステージへ移ったら、前のステージを破棄して何も出さない", async () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const stage = ref<GameStageId | null>("s1");
    const { frame } = mount(stage, registryWith({ s1: s1.module }));
    stage.value = "s2";
    await nextTick();
    expect(log).toEqual(["setup:s1", "dispose:s1"]);
    expect(frame.instance.value).toBeNull();
  });

  it("ステージが無くなったら（古いタブ・入室画面）破棄し、戻ってきたら組み立て直す", async () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const stage = ref<GameStageId | null>("s1");
    const { frame } = mount(stage, registryWith({ s1: s1.module }));
    stage.value = null;
    await nextTick();
    expect(frame.instance.value).toBeNull();
    stage.value = "s1";
    await nextTick();
    expect(log).toEqual(["setup:s1", "dispose:s1", "setup:s1"]);
  });

  it("外側が破棄されたらステージも破棄する", () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const { frame, scope } = mount(ref<GameStageId | null>("s1"), registryWith({ s1: s1.module }));
    scope.stop();
    expect(log).toEqual(["setup:s1", "dispose:s1"]);
    expect(frame.instance.value).toBeNull();
  });

  it("focus・窓の要求・右ペインの上書きはステージのものを映す", () => {
    const log: string[] = [];
    const s1 = trackedStage("s1", log);
    const { frame } = mount(ref<GameStageId | null>("s1"), registryWith({ s1: s1.module }));
    expect([frame.focus.value, frame.overlayWanted.value, frame.rightOverride.value]).toEqual([
      null,
      false,
      null,
    ]);
    s1.focus.value = "p1";
    s1.overlayWanted.value = true;
    s1.rightPane.value = "shown";
    expect([frame.focus.value, frame.overlayWanted.value, frame.rightOverride.value]).toEqual([
      "p1",
      true,
      "shown",
    ]);
  });

  it("クリア演出の保留はステージのものを映す。口を持たないステージと準備中は保留しない", () => {
    const holdClear = ref(true);
    const holding: StageModule = {
      setup: () => ({ center: { render: () => null }, overlay: { render: () => null }, holdClear }),
    };
    const bare: StageModule = { setup: () => ({ center: { render: () => null } }) };
    const { frame } = mount(ref<GameStageId | null>("s1"), registryWith({ s1: holding }));
    expect(frame.clearHeld.value).toBe(true);
    holdClear.value = false;
    expect(frame.clearHeld.value).toBe(false);
    const { frame: bareFrame } = mount(ref<GameStageId | null>("s4"), registryWith({ s4: bare }));
    expect(bareFrame.clearHeld.value).toBe(false);
    const { frame: soonFrame } = mount(ref<GameStageId | null>("s3"), registryWith({}));
    expect(soonFrame.clearHeld.value).toBe(false);
  });

  it("保留中は overlayWanted を立て忘れても、ステージの窓（stage 層）を出す", () => {
    const holdClear = ref(true);
    const holding: StageModule = {
      setup: () => ({ center: { render: () => null }, overlay: { render: () => null }, holdClear }),
    };
    const { frame } = mount(ref<GameStageId | null>("s1"), registryWith({ s1: holding }));
    expect([frame.clearHeld.value, frame.overlayWanted.value]).toEqual([true, true]);
    holdClear.value = false;
    expect([frame.clearHeld.value, frame.overlayWanted.value]).toEqual([false, false]);
  });

  it("窓の部品を持たないステージが保留を立てても保留しない（演出を出して詰まらせない）", () => {
    const noWindow: StageModule = {
      setup: () => ({ center: { render: () => null }, holdClear: ref(true) }),
    };
    const { frame } = mount(ref<GameStageId | null>("s1"), registryWith({ s1: noWindow }));
    expect([frame.clearHeld.value, frame.overlayWanted.value]).toEqual([false, false]);
  });

  it("窓を持たないステージの一時停止（pauseClear）は演出を止めるが、窓は出さない", () => {
    const pauseClear = ref(true);
    const pausing: StageModule = {
      setup: () => ({ center: { render: () => null }, pauseClear }),
    };
    const { frame } = mount(ref<GameStageId | null>("s2"), registryWith({ s2: pausing }));
    expect([frame.clearHeld.value, frame.overlayWanted.value]).toEqual([true, false]);
    pauseClear.value = false;
    expect([frame.clearHeld.value, frame.overlayWanted.value]).toEqual([false, false]);
  });

  it("保留していたステージを離れたら、保留は残らない", async () => {
    const holding: StageModule = {
      setup: () => ({
        center: { render: () => null },
        overlay: { render: () => null },
        holdClear: ref(true),
      }),
    };
    const stage = ref<GameStageId | null>("s1");
    const { frame } = mount(stage, registryWith({ s1: holding }));
    expect(frame.clearHeld.value).toBe(true);
    stage.value = "s2";
    await nextTick();
    expect(frame.clearHeld.value).toBe(false);
  });

  it("focus などを持たないステージは既定（null・窓なし・上書きなし）", () => {
    const bare: StageModule = { setup: () => ({ center: { render: () => null } }) };
    const { frame } = mount(ref<GameStageId | null>("s4"), registryWith({ s4: bare }));
    expect(frame.instance.value).not.toBeNull();
    expect([frame.focus.value, frame.overlayWanted.value, frame.rightOverride.value]).toEqual([
      null,
      false,
      null,
    ]);
  });

  it("ビューアの toolbar には、開いている文書に応じたステージの部品を出す（無ければ出さない）", async () => {
    const addButton = { render: () => null };
    const withToolbar: StageModule = {
      setup: () => ({
        center: { render: () => null },
        viewerToolbar: (doc) => (doc === "s3manual" ? addButton : null),
      }),
    };
    const bare: StageModule = { setup: () => ({ center: { render: () => null } }) };
    const stage = ref<GameStageId | null>("s2");
    const { frame } = mount(stage, registryWith({ s2: withToolbar, s3: bare }));
    expect(frame.viewerToolbar("s3manual")).toBe(addButton);
    expect(frame.viewerToolbar("s1memo")).toBeNull();
    expect(frame.viewerToolbar(null)).toBeNull();
    stage.value = "s3";
    await nextTick();
    expect(frame.viewerToolbar("s3manual")).toBeNull();
    stage.value = "s4";
    await nextTick();
    expect(frame.viewerToolbar("s3manual")).toBeNull();
  });

  it("右ペインのチャット送信は、口を持つステージではその関数、持たない・準備中のステージでは既定（undefined）", async () => {
    const sent: string[] = [];
    const chatSubmit = (text: string) => {
      sent.push(text);
      return { text: "返答" };
    };
    const withChat: StageModule = {
      setup: () => ({ center: { render: () => null }, chatSubmit }),
    };
    const bare: StageModule = { setup: () => ({ center: { render: () => null } }) };
    const stage = ref<GameStageId | null>("s2");
    const { frame } = mount(stage, registryWith({ s2: withChat, s3: bare }));
    expect(frame.chatSubmit.value).toBe(chatSubmit);
    frame.chatSubmit.value?.("台本");
    expect(sent).toEqual(["台本"]);
    stage.value = "s3";
    await nextTick();
    expect(frame.chatSubmit.value).toBeUndefined();
    stage.value = "s4";
    await nextTick();
    expect(frame.chatSubmit.value).toBeUndefined();
  });

  it("ステージが持つ会話は、持つステージの間だけ出し、離れると消える（持たないステージは undefined）", async () => {
    const chat = { turns: shallowRef([]), send: () => undefined };
    const withChat: StageModule = { setup: () => ({ center: { render: () => null }, chat }) };
    const bare: StageModule = { setup: () => ({ center: { render: () => null } }) };
    const stage = ref<GameStageId | null>("s6");
    const { frame } = mount(stage, registryWith({ s6: withChat, s5: bare }));
    expect(frame.chat.value).toBe(chat);
    stage.value = "s5";
    await nextTick();
    expect(frame.chat.value).toBeUndefined();
    stage.value = "final";
    await nextTick();
    expect(frame.chat.value).toBeUndefined();
  });
});
