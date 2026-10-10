import { stage5IncidentReport, stage5Penalty, stage5ReportVerdicts } from "@hell-ict/content";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { GameCommandInput, SendOutcome } from "../../../src/composables/use-game-session.js";
import type { Tone } from "../../../src/ports.js";
import { PENALTY_DONE_MS } from "../../../src/stages/penalty/penalty-done.js";
import { REDACT_CLICK_TONE, REDACT_DONE_CHIME } from "../../../src/stages/s5/s5-sounds.js";
import {
  STAGE5_PENALTY_HOLD_MS,
  useRedactPenalty,
} from "../../../src/stages/s5/use-redact-penalty.js";
import { FakeScheduler, flush } from "../../fakes.js";
import { answer, s5State } from "./s5-fixtures.js";

const where = (pii: boolean | undefined): number[] =>
  stage5IncidentReport.flatMap((segment, i) => (segment.pii === pii ? [i] : []));
const PII = where(true);
const [PLAIN = 0] = where(undefined);
const [NOT_PII = 0] = where(false);

const incomplete = (missing: boolean, over: boolean): SendOutcome =>
  answer({
    status: "rejected",
    reason: "report-incomplete",
    judgement: { outcome: "reject", missing, over },
  });

const mount = () => {
  const active = ref(true);
  const scheduler = new FakeScheduler();
  const serverNow = ref(1_000_000);
  const sent: { command: GameCommandInput; commandId: string }[] = [];
  const sounds: string[] = [];
  const tones: Tone[] = [];
  const outcomes: SendOutcome[] = [];
  let ids = 0;
  const scope = effectScope();
  const penalty = scope.run(() =>
    useRedactPenalty({
      active: () => active.value,
      send: (command, commandId) => {
        sent.push({ command, commandId });
        return Promise.resolve(outcomes.shift() ?? { kind: "unavailable" });
      },
      newCommandId: () => `id-${String((ids += 1))}`,
      serverNow,
      scheduler,
      sfx: { play: (name) => sounds.push(name), tone: (tone) => tones.push(tone) },
    }),
  );
  if (penalty === undefined) throw new Error("the scope did not run");
  const maskAll = () => {
    for (const i of PII) penalty.toggle(i);
  };
  return { penalty, active, scheduler, serverNow, sent, sounds, tones, outcomes, scope, maskAll };
};

describe("useRedactPenalty", () => {
  it("塗れるのは pii の有無が決まった語だけ。もう一度押すと戻る", () => {
    const { penalty } = mount();
    penalty.toggle(PLAIN);
    penalty.toggle(-1);
    penalty.toggle(stage5IncidentReport.length);
    expect(penalty.masked.value.size).toBe(0);
    penalty.toggle(NOT_PII);
    expect([...penalty.masked.value]).toEqual([NOT_PII]);
    penalty.toggle(NOT_PII);
    expect(penalty.masked.value.size).toBe(0);
  });

  it("塗るたび・戻すたびにクリック音を1回。塗れない語や受け付けない間は鳴らさない", async () => {
    const { penalty, tones, outcomes, maskAll } = mount();
    penalty.toggle(PLAIN);
    penalty.toggle(-1);
    expect(tones).toEqual([]);
    penalty.toggle(NOT_PII);
    penalty.toggle(NOT_PII);
    expect(tones).toEqual([REDACT_CLICK_TONE, REDACT_CLICK_TONE]);
    tones.length = 0;
    maskAll();
    expect(tones).toHaveLength(PII.length);
    tones.length = 0;
    outcomes.push(answer({ judgement: { outcome: "pass" } }, s5State("done")));
    penalty.submit();
    penalty.toggle(NOT_PII); // sending
    await flush();
    penalty.toggle(NOT_PII); // holding
    expect(tones).not.toContainEqual(REDACT_CLICK_TONE);
  });

  it("通ったときだけ控えめなクリア音（上がる2音）を1回。差し戻しでは鳴らさない", async () => {
    const { penalty, active, tones, scheduler, outcomes, maskAll } = mount();
    outcomes.push(incomplete(true, false));
    penalty.submit();
    await flush();
    scheduler.advanceBy(1_000);
    expect(tones).toEqual([]);
    maskAll();
    tones.length = 0;
    outcomes.push(answer({ judgement: { outcome: "pass" } }, s5State("done")));
    penalty.submit();
    active.value = false;
    await flush();
    scheduler.advanceBy(0);
    expect(tones).toEqual([REDACT_DONE_CHIME[0]?.tone]);
    scheduler.advanceBy(STAGE5_PENALTY_HOLD_MS);
    expect(tones).toEqual(REDACT_DONE_CHIME.map((note) => note.tone));
    const [first, second] = REDACT_DONE_CHIME;
    expect(second?.tone.frequencyHz).toBeGreaterThan(first?.tone.frequencyHz ?? Infinity);
    for (const note of REDACT_DONE_CHIME) expect(note.tone.volume).toBeLessThanOrEqual(0.12);
  });

  it("クリア音の途中でスコープを捨てたら、残りの音は鳴らない", async () => {
    const { penalty, tones, scope, scheduler, outcomes } = mount();
    outcomes.push(answer({ judgement: { outcome: "pass" } }, s5State("done")));
    penalty.submit();
    await flush();
    scheduler.advanceBy(0);
    scope.stop();
    scheduler.advanceBy(1_000);
    expect(tones).toHaveLength(1);
    expect(scheduler.pending).toBe(0);
  });

  it("差し戻しは文と cancel。塗り残しと塗りすぎは両方言い、何度でも出し直せる", async () => {
    const { penalty, sent, sounds, outcomes } = mount();
    penalty.toggle(NOT_PII);
    outcomes.push(incomplete(true, true));
    penalty.submit();
    expect(penalty.verdict.value).toEqual({ kind: "checking" });
    penalty.submit();
    await flush();
    expect(sent).toHaveLength(1);
    expect(penalty.verdict.value).toEqual({
      kind: "rejected",
      lines: [stage5ReportVerdicts.missing, stage5ReportVerdicts.over],
    });
    expect(sounds).toEqual(["cancel"]);
    outcomes.push(incomplete(true, false));
    penalty.submit();
    await flush();
    expect(sent.map((s) => s.commandId)).toEqual(["id-1", "id-2"]);
  });

  it("届かなければ同じ塗り方は同じ commandId で送り直し、塗り方を変えたら新しい id", async () => {
    const { penalty, sent, maskAll } = mount();
    maskAll();
    penalty.submit();
    await flush();
    expect(penalty.verdict.value?.kind).toBe("rejected");
    penalty.submit();
    await flush();
    penalty.toggle(NOT_PII);
    penalty.submit();
    await flush();
    expect(sent.map((s) => s.commandId)).toEqual(["id-1", "id-1", "id-2"]);
    expect(sent[0]?.command).toEqual({ type: "s5.submit-report", maskedIndices: PII });
  });

  it("届かなかった送信の送り直しが、差し戻しの duplicate で返れば差し戻しを言い、罰は続く", async () => {
    const { penalty, sent, sounds, outcomes } = mount();
    penalty.submit();
    await flush();
    const judgement = { outcome: "reject", missing: true, over: false };
    outcomes.push(
      answer({ status: "duplicate", original: { events: [], judgement } }, s5State("in-progress")),
    );
    penalty.submit();
    await flush();
    expect(sent.map((s) => s.commandId)).toEqual(["id-1", "id-1"]);
    expect(penalty.verdict.value).toEqual({
      kind: "rejected",
      lines: [stage5ReportVerdicts.missing],
    });
    expect(penalty.holding.value).toBe(false);
    expect(sounds).toEqual(["cancel"]);
    penalty.toggle(PII[0] ?? 0);
    expect(penalty.masked.value.size).toBe(1);
  });

  it("通れば「送信しました」と罰ゲーム完了を、長い方の時間だけ見せて閉じる。その間は塗りも提出も受け付けない", async () => {
    const { penalty, active, sent, scheduler, outcomes, maskAll } = mount();
    maskAll();
    outcomes.push(answer({ judgement: { outcome: "pass" } }, s5State("done")));
    penalty.submit();
    active.value = false; // the answer's state: the server has the penalty done
    await flush();
    expect(penalty.verdict.value).toEqual({ kind: "cleared", text: stage5ReportVerdicts.sent });
    expect(penalty.holding.value).toBe(true);
    penalty.toggle(NOT_PII);
    penalty.submit();
    expect(sent).toHaveLength(1);
    expect(STAGE5_PENALTY_HOLD_MS).toBe(Math.max(stage5Penalty.sentMs, PENALTY_DONE_MS));
    scheduler.advanceBy(STAGE5_PENALTY_HOLD_MS - 1);
    expect(penalty.holding.value).toBe(true);
    scheduler.advanceBy(1);
    expect(penalty.holding.value).toBe(false);
  });

  it("罰が始まるたびに白紙から（再読み込みも同じ、決定5）。時計はそこから数える", async () => {
    const { penalty, active, serverNow } = mount();
    penalty.toggle(NOT_PII);
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 250;
    await nextTick();
    expect(penalty.elapsedMs.value).toBe(0);
    serverNow.value += 5_000;
    expect(penalty.elapsedMs.value).toBe(5_000);
    active.value = false;
    await nextTick();
    penalty.toggle(PII[0] ?? 0);
    expect([...penalty.masked.value]).toEqual([NOT_PII]);
    active.value = true;
    await nextTick();
    expect(penalty.masked.value.size).toBe(0);
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

  it("払い済み（別のタブ）の拒否は何も言わない。返事の前にスコープを捨てたら何も書き換えない", async () => {
    const first = mount();
    first.outcomes.push(answer({ status: "rejected", reason: "no-penalty-in-progress" }));
    first.penalty.submit();
    await flush();
    expect(first.penalty.verdict.value).toBeNull();
    const { penalty, scope, sounds, outcomes, scheduler } = mount();
    outcomes.push(answer({ judgement: { outcome: "pass" } }));
    penalty.submit();
    scope.stop();
    await flush();
    expect(penalty.holding.value).toBe(false);
    expect(sounds).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });
});
