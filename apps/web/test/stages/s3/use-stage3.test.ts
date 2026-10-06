import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref, shallowRef } from "vue";

import type { GameCommandInput, SendOutcome } from "../../../src/composables/use-game-session.js";
import { PENALTY_DONE_MS } from "../../../src/stages/penalty/penalty-done.js";
import { NOTICE_DELAY_MS } from "../../../src/stages/s3/s3-view.js";
import { BLACKOUT_MS, useStage3 } from "../../../src/stages/s3/use-stage3.js";
import { FakeKeyValueStorage, FakeScheduler, flush } from "../../fakes.js";
import { applied, ENTERED_MS, s3State } from "./s3-fixtures.js";

const DRAFT_KEY = "hellVueS3Draft:123456";
const NOTICE_KEY = "hellVueS3Notice:123456";

const mount = (storage = new FakeKeyValueStorage()) => {
  const state = shallowRef<TeamGameViewState>(s3State());
  const sent: GameCommandInput[] = [];
  const sounds: string[] = [];
  let answer: () => Promise<SendOutcome> = () => Promise.resolve({ kind: "unavailable" });
  const scheduler = new FakeScheduler();
  const serverNow = ref(ENTERED_MS + NOTICE_DELAY_MS);
  const scope = effectScope();
  const stage = scope.run(() =>
    useStage3({
      state: () => state.value,
      teamCode: () => "123456",
      send: (command) => {
        sent.push(command);
        return answer();
      },
      serverNow,
      storage,
      scheduler,
      sfx: { play: (name) => sounds.push(name), tone: () => undefined },
    }),
  );
  if (stage === undefined) throw new Error("the scope did not run");
  const answerWith = (outcome: SendOutcome, next?: TeamGameViewState) => {
    answer = () => {
      if (next !== undefined) state.value = next;
      return Promise.resolve(outcome);
    };
  };
  return { stage, state, sent, sounds, scheduler, scope, storage, answerWith };
};

describe("useStage3", () => {
  it("書きかけは打つたびに sessionStorage へ残り、再読み込みで戻る", async () => {
    const { stage, storage } = mount();
    stage.draft.ppe = "標準予防策";
    await nextTick();
    expect(JSON.parse(storage.values.get(DRAFT_KEY) ?? "null")).toEqual({
      ppe: "標準予防策",
      release: "",
      clean: "",
    });
    expect(mount(storage).stage.draft.ppe).toBe("標準予防策");
  });

  it("壊れた書きかけは捨てて空欄から。保存できなくても入力は続けられる", async () => {
    const broken = new FakeKeyValueStorage();
    broken.values.set(DRAFT_KEY, '{"ppe":1}');
    expect(mount(broken).stage.draft).toEqual({ ppe: "", release: "", clean: "" });
    expect(broken.values.has(DRAFT_KEY)).toBe(false);
    const blocked = new FakeKeyValueStorage();
    blocked.failing = true;
    const { stage } = mount(blocked);
    stage.draft.clean = "通常の洗濯";
    await nextTick();
    expect(stage.draft.clean).toBe("通常の洗濯");
  });

  it("一報は了解で閉じ、sessionStorage に残るので再読み込みで出し直さない", () => {
    const { stage, storage } = mount();
    expect(stage.overlay.value).toBe("notice");
    stage.dismissNotice();
    expect(stage.overlay.value).toBeNull();
    expect(storage.values.get(NOTICE_KEY)).toBe("true");
    expect(mount(storage).stage.overlay.value).toBeNull();
  });

  it("提出は3欄をそのまま送り、返事待ちの間は判定中。差し戻しは欄を指して cancel を鳴らす", async () => {
    const { stage, sent, sounds, answerWith } = mount();
    stage.draft.ppe = "PPE欄の下書き";
    answerWith(applied({ outcome: "reject", field: "ppe" }, ["submission-rejected"]));
    const done = stage.submit();
    expect(stage.submitting.value).toBe(true);
    expect(stage.verdict.value).toEqual({ kind: "checking" });
    await done;
    expect(sent).toEqual([
      { type: "s3.submit", submission: { ppe: "PPE欄の下書き", release: "", clean: "" } },
    ]);
    expect(stage.warnField.value).toBe("ppe");
    expect(stage.verdict.value?.kind).toBe("rejected");
    expect(sounds).toEqual(["cancel"]);
    expect(stage.submitting.value).toBe(false);
  });

  it("返事待ちの間にもう一度押しても2回は送らない", async () => {
    const { stage, sent, answerWith } = mount();
    answerWith(applied({ outcome: "pass" }, ["stage-cleared"]));
    const first = stage.submit();
    await stage.submit();
    await first;
    expect(sent).toHaveLength(1);
    expect(stage.verdict.value).toEqual({ kind: "cleared", text: "Stage 3 をクリアしました" });
  });

  it("届かなかったら判定の表示を消し、もう一度押せる", async () => {
    const { stage, sounds } = mount();
    await stage.submit();
    expect(stage.verdict.value).toBeNull();
    expect(stage.warnField.value).toBeNull();
    expect(sounds).toEqual([]);
  });

  it("罠の初回: 暗転と don-1 → 1400ms で叱責 → 了解で罰の窓", async () => {
    const { stage, sounds, scheduler, answerWith } = mount();
    stage.dismissNotice();
    answerWith(
      applied({ outcome: "trap", field: "ppe" }, ["trap-triggered"], s3State("in-progress")),
      s3State("in-progress"),
    );
    await stage.submit();
    expect(stage.overlay.value).toBe("blackout");
    expect(sounds).toEqual(["don-1"]);
    expect(stage.verdict.value).toBeNull();
    scheduler.advanceBy(BLACKOUT_MS - 1);
    expect(stage.overlay.value).toBe("blackout");
    scheduler.advanceBy(1);
    expect(stage.overlay.value).toBe("scold");
    stage.dismissScold();
    expect(stage.overlay.value).toBe("penalty");
  });

  it("2回目の罠では罰を繰り返さず、正典を促す文言だけ", async () => {
    const { stage, sounds, state, answerWith } = mount();
    state.value = s3State("done");
    answerWith(applied({ outcome: "trap", field: "clean" }, ["trap-repeated"], s3State("done")));
    await stage.submit();
    expect(stage.overlay.value).toBeNull();
    expect(stage.verdict.value).toEqual({
      kind: "rejected",
      lines: ["まだ基準が正しくありません。院内感染対策マニュアルを確認してください。"],
    });
    expect(sounds).toEqual([]);
  });

  it("罰の途中で再読み込みしたら、暗転も叱責も無しに罰の窓から", () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(NOTICE_KEY, "true");
    const { stage, state } = mount(storage);
    state.value = s3State("in-progress");
    expect(stage.overlay.value).toBe("penalty");
  });

  it("ステージを離れたら暗転の予約を取り消す", async () => {
    const { stage, scheduler, scope, answerWith } = mount();
    answerWith(
      applied({ outcome: "trap", field: "ppe" }, ["trap-triggered"]),
      s3State("in-progress"),
    );
    await stage.submit();
    await flush();
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});

describe("useStage3: 罰ゲームの完了表示", () => {
  it("送る時から窓を保ち、払い終えから PENALTY_DONE_MS ちょうどまで完了を見せて閉じ、苅部さんはその後", () => {
    const { stage, state, scheduler } = mount();
    state.value = s3State("in-progress");
    stage.penaltyFinishing();
    expect(stage.verdict.value).toBeNull();
    // The answer's state arrives before the answer is read: the window stays, not yet "done".
    state.value = s3State("done");
    expect([stage.overlay.value, stage.penaltyDoneShown.value]).toEqual(["penalty", true]);
    expect(stage.karubeCalls.value).toEqual([]);
    stage.penaltyFinished(true);
    expect([stage.penaltyHeld.value, stage.overlay.value]).toEqual([true, "penalty"]);
    expect(stage.karubeCalls.value).toEqual([]);
    scheduler.advanceBy(PENALTY_DONE_MS - 1);
    expect(stage.overlay.value).toBe("penalty");
    scheduler.advanceBy(1);
    expect([stage.penaltyHeld.value, stage.overlay.value]).toEqual([false, null]);
    expect(stage.karubeCalls.value).toHaveLength(1);
  });

  it("送る間はまだ完了と出さない。届かなければ保つのをやめ、罰の窓（再送）のまま", () => {
    const { stage, state, scheduler } = mount();
    state.value = s3State("in-progress");
    stage.penaltyFinishing();
    expect([stage.overlay.value, stage.penaltyDoneShown.value]).toEqual(["penalty", false]);
    stage.penaltyFinished(false);
    expect([stage.penaltyHeld.value, stage.overlay.value]).toEqual([false, "penalty"]);
    expect(scheduler.pending).toBe(0);
  });

  it("再読み込み（別タブ）で払い終えた状態から開いたら、窓を保たない", () => {
    const { stage, state } = mount();
    state.value = s3State("done");
    expect([stage.penaltyHeld.value, stage.overlay.value]).toEqual([false, null]);
    expect(stage.karubeCalls.value).toHaveLength(1);
  });

  it("保っている間にステージを離れたら、タイマーは残らない", () => {
    const { stage, scheduler, scope } = mount();
    stage.penaltyFinishing();
    stage.penaltyFinished(true);
    expect(scheduler.pending).toBe(1);
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});

describe("useStage3: 苅部さん", () => {
  const REJECTED_KEY = "hellVueS3Rejected:123456";
  const ENTERED = s3State().enteredAt.s3 ?? "";
  const reject = () => applied({ outcome: "reject", field: "ppe" }, ["submission-rejected"]);
  const callNames = (stage: { karubeCalls: { value: readonly { callId: string }[] } }) =>
    stage.karubeCalls.value.map((call) => call.callId.replace(`s3:${ENTERED}:`, ""));

  it("罠の前の差し戻しで鳴り、滞在の入室時刻を sessionStorage に残すので再読み込みでも同じ一覧", async () => {
    const { stage, storage, answerWith } = mount();
    expect(stage.karubeCalls.value).toEqual([]);
    answerWith(reject());
    await stage.submit();
    expect(callNames(stage)).toEqual(["lines"]);
    expect(JSON.parse(storage.values.get(REJECTED_KEY) ?? "null")).toBe(ENTERED);
    expect(callNames(mount(storage).stage)).toEqual(["lines"]);
  });

  it("罰明けの差し戻しは記録しない（罠の後の差し戻しでは鳴らない）", async () => {
    const { stage, state, storage, answerWith } = mount();
    state.value = s3State("done");
    answerWith(
      applied({ outcome: "reject", field: "ppe" }, ["submission-rejected"], s3State("done")),
    );
    await stage.submit();
    expect(storage.values.has(REJECTED_KEY)).toBe(false);
    expect(callNames(stage)).toEqual(["lines"]);
  });

  it("罰明け: 差し戻し済みなら lines と after-trap、記録が無ければ lines だけ", () => {
    const withRecord = new FakeKeyValueStorage();
    withRecord.values.set(REJECTED_KEY, JSON.stringify(ENTERED));
    const recorded = mount(withRecord);
    recorded.state.value = s3State("done");
    expect(callNames(recorded.stage)).toEqual(["lines", "after-trap"]);
    const fresh = mount();
    fresh.state.value = s3State("done");
    expect(callNames(fresh.stage)).toEqual(["lines"]);
  });

  it("壊れた記録は捨てて差し戻し無しとして読む。保存できなくてもこの画面では鳴る", async () => {
    const broken = new FakeKeyValueStorage();
    broken.values.set(REJECTED_KEY, '"yesterday"');
    expect(mount(broken).stage.karubeCalls.value).toEqual([]);
    expect(broken.values.has(REJECTED_KEY)).toBe(false);
    const blocked = new FakeKeyValueStorage();
    blocked.failing = true;
    const { stage, answerWith } = mount(blocked);
    answerWith(reject());
    await stage.submit();
    expect(callNames(stage)).toEqual(["lines"]);
  });

  it("届かなかった提出や罠は差し戻しとして記録しない", async () => {
    const { stage, storage, answerWith } = mount();
    answerWith({ kind: "unavailable" });
    await stage.submit();
    answerWith(
      applied({ outcome: "trap", field: "ppe" }, ["trap-triggered"], s3State("in-progress")),
      s3State("in-progress"),
    );
    await stage.submit();
    expect(storage.values.has(REJECTED_KEY)).toBe(false);
    expect(stage.karubeCalls.value).toEqual([]);
  });
});
