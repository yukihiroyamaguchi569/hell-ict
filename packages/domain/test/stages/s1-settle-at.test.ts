import { describe, expect, it } from "vitest";

import { DEADLINE_GRACE_MS } from "../../src/stages/deadline.js";
import {
  acknowledgeStage1RoundResult,
  sendStage1Reply,
  settleStage1Round,
  STAGE1_REPLY_LIMIT_MS,
  STAGE1_SCHEDULES,
  stage1SettleAt,
  startStage1,
} from "../../src/stages/s1.js";
import type { Stage1State } from "../../src/stages/s1.js";

const T0 = 1_790_000_000_000;
const GOOD = "ご連絡ありがとうございます。".repeat(5) + "よろしくお願いいたします。";
/** The last mail of every round lands 23 s after the round starts. */
const LAST_LANDING_MS = 23_000;
const UNTOUCHED_AT = T0 + LAST_LANDING_MS + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1;

const replyAll = (state: Stage1State, ids: readonly string[], now: number): Stage1State =>
  STAGE1_SCHEDULES[state.round]
    .filter((mail) => ids.includes(mail.id))
    .reduce((next, mail) => sendStage1Reply(next, mail.id, GOOD, now).state, state);

describe("stage1SettleAt", () => {
  it("手つかずのラウンドは、最後の1通の締切と猶予の 1ms 後", () => {
    expect(stage1SettleAt(startStage1(T0))).toBe(UNTOUCHED_AT);
  });

  it("その時刻ちょうどでラウンドが終わり、1ms 前では終わらない（サーバの判定と一致）", () => {
    const state = startStage1(T0);
    expect(settleStage1Round(state, UNTOUCHED_AT - 1).settlement.type).toBe("none");
    expect(settleStage1Round(state, UNTOUCHED_AT).settlement.type).toBe("round-failed");
  });

  it("最後の1通に返信済みなら、まだ残る1通の締切で決まる", () => {
    const state = replyAll(startStage1(T0), ["m8"], T0 + 30_000);
    const m4Landing = 17_000;
    expect(stage1SettleAt(state)).toBe(
      T0 + m4Landing + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1,
    );
  });

  it("全通返信済み（最後の返信で決着している）なら、最後の着弾時刻＝もう過ぎた時刻", () => {
    const state = {
      ...startStage1(T0),
      doneIds: STAGE1_SCHEDULES[1].map((mail) => mail.id),
    } satisfies Stage1State;
    expect(stage1SettleAt(state)).toBe(T0 + LAST_LANDING_MS);
  });

  it("結果窓の間とクリア後は null（送るものが無い）", () => {
    const failed = settleStage1Round(startStage1(T0), UNTOUCHED_AT).state;
    expect(failed.status.phase).toBe("round-result");
    expect(stage1SettleAt(failed)).toBeNull();
    const cleared = settleStage1Round(
      replyAll(startStage1(T0), ["m1", "m2", "m3", "m4", "m8"], T0 + 30_000),
      T0 + 30_000,
    ).state;
    expect(cleared.status.phase).toBe("cleared");
    expect(stage1SettleAt(cleared)).toBeNull();
  });

  it("次のラウンドはそのラウンドの開始から数え直す（R3 のやり直しも）", () => {
    const failed = settleStage1Round(startStage1(T0), UNTOUCHED_AT).state;
    const round2At = UNTOUCHED_AT + 5_000;
    const round2 = acknowledgeStage1RoundResult(failed, round2At);
    expect(round2).not.toBeNull();
    if (round2 === null) return;
    expect(stage1SettleAt(round2)).toBe(UNTOUCHED_AT - T0 + round2At);
  });
});
