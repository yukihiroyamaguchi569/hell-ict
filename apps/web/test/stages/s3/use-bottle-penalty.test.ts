import { stage3Penalty } from "@hell-ict/content";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { GameCommandInput, SendOutcome } from "../../../src/composables/use-game-session.js";
import { useBottlePenalty } from "../../../src/stages/s3/use-bottle-penalty.js";
import { FakeScheduler, flush } from "../../fakes.js";
import { applied, s3State } from "./s3-fixtures.js";

const FILL = stage3Penalty.fillMs;

const mount = () => {
  const active = ref(true);
  const scheduler = new FakeScheduler();
  const serverNow = ref(1_000_000);
  const sent: { command: GameCommandInput; commandId: string | undefined }[] = [];
  const sounds: string[] = [];
  const outcomes: SendOutcome[] = [];
  /** What the stage was told, in order: "finishing", then "paid" or "failed". */
  const reports: string[] = [];
  let ids = 0;
  const scope = effectScope();
  const penalty = scope.run(() =>
    useBottlePenalty({
      active: () => active.value,
      send: (command, commandId) => {
        sent.push({ command, commandId });
        return Promise.resolve(outcomes.shift() ?? applied(null, [], s3State("done")));
      },
      newCommandId: () => `id-${String((ids += 1))}`,
      serverNow,
      scheduler,
      sfx: {
        play: (name, volume) => sounds.push(`${name}@${String(volume ?? "")}`),
        tone: () => undefined,
      },
      onFinishing: () => {
        reports.push("finishing");
      },
      onFinished: (paid) => {
        reports.push(paid ? "paid" : "failed");
      },
    }),
  );
  if (penalty === undefined) throw new Error("the scope did not run");
  /** Presses every bottle still to do and lets them fill. */
  const fillAll = () => {
    penalty.shelf.value.bottles.forEach((_, i) => {
      penalty.fill(i);
    });
    scheduler.advanceBy(FILL);
  };
  return {
    penalty,
    active,
    scheduler,
    serverNow,
    sent,
    sounds,
    outcomes,
    scope,
    fillAll,
    reports,
  };
};

describe("useBottlePenalty", () => {
  it("押すと控えめな音で詰め始め、700ms で済みになる。詰め中を押し直しても鳴らない", () => {
    const { penalty, scheduler, sounds } = mount();
    penalty.fill(0);
    penalty.fill(0);
    expect(sounds).toEqual(["decision1@0.22"]);
    expect(penalty.shelf.value.bottles[0]?.state).toBe("filling");
    scheduler.advanceBy(FILL - 1);
    expect(penalty.shelf.value.bottles[0]?.state).toBe("filling");
    scheduler.advanceBy(1);
    expect(penalty.shelf.value.bottles[0]?.state).toBe("done");
  });

  it("追加分が湧くと注記が変わり cancel が鳴り、棚の滑り込みは 1200ms で終わる", () => {
    const { penalty, scheduler, sounds } = mount();
    for (let i = 0; i < 15; i++) penalty.fill(i);
    scheduler.advanceBy(FILL);
    expect(penalty.note.value).toBe("5B病棟からも依頼が来ています。あわせて補充してください。");
    expect(penalty.freshWard.value).toBe("5B");
    expect(sounds.filter((s) => s.startsWith("cancel"))).toHaveLength(1);
    scheduler.advanceBy(stage3Penalty.waveFlashMs);
    expect(penalty.freshWard.value).toBeNull();
  });

  it("40本すべて詰めたら finish-penalty を1回だけ送り、送る前に知らせ、払い終えを知らせる", async () => {
    const { fillAll, sent, reports } = mount();
    fillAll();
    fillAll();
    expect(sent).toHaveLength(0);
    expect(reports).toEqual([]);
    fillAll();
    // Told before the answer: the state may turn `done` before the answer is read.
    expect(reports).toEqual(["finishing"]);
    await flush();
    expect(sent).toEqual([{ command: { type: "s3.finish-penalty" }, commandId: "id-1" }]);
    expect(reports).toEqual(["finishing", "paid"]);
  });

  it("届かなければ再送のボタンを出し、同じ commandId で送り直す", async () => {
    const { penalty, fillAll, sent, outcomes, reports } = mount();
    outcomes.push({ kind: "unavailable" });
    fillAll();
    fillAll();
    fillAll();
    await flush();
    expect(penalty.failed.value).toBe(true);
    expect(reports).toEqual(["finishing", "failed"]);
    penalty.retry();
    await flush();
    expect(sent.map((s) => s.commandId)).toEqual(["id-1", "id-1"]);
    expect(penalty.failed.value).toBe(false);
    expect(reports).toEqual(["finishing", "failed", "finishing", "paid"]);
  });

  it("窓が出直すたびに棚は最初から（再読み込みで軽くならない）。時計も0から", async () => {
    const { penalty, active, scheduler, serverNow } = mount();
    penalty.fill(0);
    scheduler.advanceBy(FILL);
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 250;
    await nextTick();
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 30_000;
    expect(penalty.elapsedMs.value).toBe(30_000);
    active.value = false;
    await nextTick();
    active.value = true;
    await nextTick();
    expect(penalty.shelf.value.bottles.every((b) => b.state === "todo")).toBe(true);
    expect(penalty.note.value).toBe(stage3Penalty.note);
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 250;
    await nextTick();
    serverNow.value += 1_000;
    expect(penalty.elapsedMs.value).toBe(1_000);
  });

  it("再読み込みでサーバとの時差が後から分かっても、時計は PC の時刻からではなく0から数える", async () => {
    // Built with the PC's own time (10 minutes behind the server), then the offset is learnt.
    const { penalty, serverNow } = mount();
    serverNow.value += 10 * 60_000;
    await nextTick();
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 3_000;
    expect(penalty.elapsedMs.value).toBe(3_000);
  });

  it("別タブが先に罰を払って窓が消えたら、詰め中の予約を取り消し finish-penalty を送らない", async () => {
    const { penalty, active, scheduler, sent, fillAll } = mount();
    fillAll();
    fillAll();
    for (let i = 30; i < 40; i++) penalty.fill(i);
    active.value = false;
    await nextTick();
    expect(scheduler.pending).toBe(0);
    scheduler.advanceBy(FILL);
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("ステージを離れたら補充の予約を残さない", () => {
    const { penalty, scheduler, scope } = mount();
    penalty.fill(0);
    penalty.fill(1);
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
