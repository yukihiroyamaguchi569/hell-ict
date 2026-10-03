import { stage5FeverRows } from "@hell-ict/content";
import { stage5DeadlineAt, type TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref, shallowRef } from "vue";

import type { GameCommandInput, SendOutcome } from "../../../src/composables/use-game-session.js";
import { ALARM_MS, useStage5 } from "../../../src/stages/s5/use-stage5.js";
import { FakeKeyValueStorage, FakeScheduler, flush } from "../../fakes.js";
import { answer, ENTERED, ENTERED_MS, s5State } from "./s5-fixtures.js";

/** The fever list's first row as pasted: ID and name (personal information). */
const PII_ROW = `${stage5FeverRows[0].id}\t${stage5FeverRows[0].name}`;

const CALL_KEY = "hellVueS5Call:123456";
const DEADLINE = stage5DeadlineAt(ENTERED);

const mount = (initial = s5State(), storage = new FakeKeyValueStorage(), now = ENTERED_MS) => {
  const state = shallowRef<TeamGameViewState>(initial);
  const sent: { command: GameCommandInput; commandId: string }[] = [];
  const sounds: string[] = [];
  const outcomes: SendOutcome[] = [];
  const scheduler = new FakeScheduler();
  const serverNow = ref(now);
  const penaltyHeld = ref(false);
  let ids = 0;
  const scope = effectScope();
  const stage = scope.run(() =>
    useStage5({
      state: () => state.value,
      teamCode: () => "123456",
      send: (command, commandId) => {
        sent.push({ command, commandId });
        return Promise.resolve(outcomes.shift() ?? { kind: "unavailable" });
      },
      newCommandId: () => `id-${String((ids += 1))}`,
      serverNow,
      storage,
      scheduler,
      sfx: { play: (name) => sounds.push(name) },
      penaltyHeld: () => penaltyHeld.value,
    }),
  );
  if (stage === undefined) throw new Error("the scope did not run");
  return {
    stage,
    state,
    sent,
    sounds,
    outcomes,
    scheduler,
    serverNow,
    penaltyHeld,
    storage,
    scope,
  };
};

describe("useStage5: 罠を見たときの演出", () => {
  it("none → in-progress を見たら警報と don-1 → 1600ms で叱責 → 了解で罰の窓", async () => {
    const { stage, state, sounds, scheduler } = mount();
    state.value = s5State("in-progress");
    await nextTick();
    expect(stage.overlay.value).toBe("alarm");
    expect(sounds).toEqual(["don-1"]);
    scheduler.advanceBy(ALARM_MS - 1);
    expect(stage.overlay.value).toBe("alarm");
    scheduler.advanceBy(1);
    expect(stage.overlay.value).toBe("scold");
    stage.dismissScold();
    expect(stage.overlay.value).toBe("penalty");
  });

  it("はじめから in-progress（再読み込み）なら演出なしで罰の窓から", async () => {
    const { stage, sounds } = mount(s5State("in-progress"));
    await nextTick();
    expect(stage.overlay.value).toBe("penalty");
    expect(sounds).toEqual([]);
  });

  it("2回目の罠（罰は払い済み、trap-repeated）では何も出さない", async () => {
    const { stage, state, sounds } = mount(s5State("done"));
    state.value = s5State("done");
    await nextTick();
    expect(stage.overlay.value).toBeNull();
    // done → in-progress はサーバが起こさない遷移: 起きても警報は鳴らさない
    state.value = s5State("in-progress");
    await nextTick();
    expect(stage.overlay.value).toBe("penalty");
    expect(sounds).toEqual([]);
  });

  it("警報の途中で罰が払われたら（別のタブ）罠の場面は出さない。スコープを捨てたら叱責へ進まない", async () => {
    const { stage, state, scheduler, scope } = mount();
    state.value = s5State("in-progress");
    await nextTick();
    state.value = s5State("done");
    expect(stage.overlay.value).toBeNull();
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});

describe("useStage5: 回答期限の督促", () => {
  it("期限ちょうどで1回だけ出る。閉じたら sessionStorage に残り、再読み込みで出し直さない", async () => {
    const { stage, serverNow, storage } = mount();
    serverNow.value = DEADLINE - 1;
    await nextTick();
    expect(stage.overlay.value).toBeNull();
    serverNow.value = DEADLINE;
    await nextTick();
    expect(stage.overlay.value).toBe("call");
    stage.dismissCall();
    serverNow.value = DEADLINE + 250;
    await nextTick();
    expect(stage.overlay.value).toBeNull();
    expect(JSON.parse(storage.values.get(CALL_KEY) ?? "null")).toBe(ENTERED);
    const again = mount(s5State(), storage, DEADLINE + 5_000);
    await nextTick();
    expect(again.stage.overlay.value).toBeNull();
  });

  it("期限後の再読み込みで閉じていなければすぐ出る。別の入場の記録や壊れた記録は捨てて出す", async () => {
    const other = new FakeKeyValueStorage();
    other.values.set(CALL_KEY, JSON.stringify("2026-10-31T00:00:00.000Z"));
    expect(mount(s5State(), other, DEADLINE + 1).stage.overlay.value).toBe("call");
    const broken = new FakeKeyValueStorage();
    broken.values.set(CALL_KEY, "{not json");
    expect(mount(s5State(), broken, DEADLINE + 1).stage.overlay.value).toBe("call");
    expect(broken.values.has(CALL_KEY)).toBe(false);
    const blocked = new FakeKeyValueStorage();
    blocked.failing = true;
    const { stage } = mount(s5State(), blocked, DEADLINE + 1);
    stage.dismissCall();
    expect(stage.overlay.value).toBeNull();
  });

  it("罰の最中に期限が来たら罰の後に出す。クリア済みなら出さない", async () => {
    const { stage, state } = mount(s5State("in-progress"), undefined, DEADLINE);
    expect(stage.overlay.value).toBe("penalty");
    state.value = s5State("done");
    await nextTick();
    expect(stage.overlay.value).toBe("call");
    expect(
      mount(s5State("none", { cleared: true }), undefined, DEADLINE).stage.overlay.value,
    ).toBeNull();
  });
});

describe("useStage5: 提出", () => {
  it("本文を s5.submit で送り、判定中 → 差し戻しは文と cancel。書きかけは保存しない", async () => {
    const { stage, sent, sounds, outcomes, storage } = mount();
    stage.text.value = PII_ROW;
    outcomes.push(answer({ judgement: { outcome: "reject", reasons: [{ reason: "temp" }] } }));
    stage.submit();
    expect(stage.verdict.value).toEqual({ kind: "checking" });
    stage.submit();
    await flush();
    expect(sent).toEqual([{ command: { type: "s5.submit", text: PII_ROW }, commandId: "id-1" }]);
    expect(stage.verdict.value?.kind).toBe("rejected");
    expect(stage.warn.value).toBe(true);
    expect(sounds).toEqual(["cancel"]);
    expect(storage.values.size).toBe(0);
  });

  it("届かなければ同じ本文は同じ commandId で送り直し、本文を変えたら新しい id", async () => {
    const { stage, sent, outcomes } = mount();
    stage.text.value = "一覧";
    stage.submit();
    await flush();
    expect(stage.verdict.value?.kind).toBe("rejected");
    stage.submit();
    await flush();
    stage.text.value = "直した一覧";
    outcomes.push(answer({ judgement: { outcome: "pass" } }, s5State("none", { cleared: true })));
    stage.submit();
    await flush();
    expect(sent.map((s) => s.commandId)).toEqual(["id-1", "id-1", "id-2"]);
    expect(stage.verdict.value).toEqual({ kind: "cleared", text: "Stage 5 をクリアしました" });
  });

  it("クリア済みなら送らない。返事の前にスコープを捨てたら何も書き換えない", async () => {
    const cleared = mount(s5State("none", { cleared: true }));
    cleared.stage.submit();
    expect(cleared.sent).toHaveLength(0);
    const { stage, scope, sounds, outcomes } = mount();
    outcomes.push(answer({ judgement: { outcome: "reject", reasons: [{ reason: "date" }] } }));
    stage.submit();
    scope.stop();
    await flush();
    expect(sounds).toEqual([]);
  });
});
