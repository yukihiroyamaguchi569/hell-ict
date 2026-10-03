import { describe, expect, it } from "vitest";

import { applyTeamGameCommand, initialTeamGameState } from "../../src/game/team-game.js";
import type { TeamGameResult } from "../../src/game/team-game.js";
import type { GameEvent } from "../../src/schemas/game.js";
import { teamGameStateSchema } from "../../src/schemas/team-game.js";
import type { TeamGameCommand, TeamGameState } from "../../src/schemas/team-game.js";
import { countStage3TrapJudgements, stage3TrapHint } from "../../src/stages/s3.js";
import type { Stage3TrapHint } from "../../src/stages/s3.js";
import { enteredStage, NOW } from "../game/helpers.js";
import { at, command, STAGE3_OK, STAGE3_TRAP } from "../game/team-game-fixtures.js";

const TRAP_TRIGGERED: GameEvent = { type: "trap-triggered", stage: "s3", at: NOW };
const TRAP_REPEATED: GameEvent = { type: "trap-repeated", stage: "s3", at: NOW };
const REJECTED: GameEvent = { type: "submission-rejected", stage: "s3", at: NOW };
const CLEARED: GameEvent = { type: "stage-cleared", stage: "s3", at: NOW };

describe("stage3TrapHint: 罠判定の通算回数で苅部さんのヒントを選ぶ（Issue #219）", () => {
  it.each([
    [1, "none"],
    [2, "type-hint"],
    [3, "type-hint"],
    [4, "final-push"],
    [5, "none"],
    [6, "none"],
    [20, "none"],
  ] as const)("罠判定の%i回目は %s", (trapJudgements, hint) => {
    const events = trapJudgements === 1 ? [TRAP_TRIGGERED] : [TRAP_REPEATED];
    expect(stage3TrapHint(events, trapJudgements)).toBe(hint);
  });

  it.each([
    ["イベントなし（再送・拒否）", []],
    ["差し戻し", [REJECTED]],
    ["クリア", [CLEARED]],
    ["Stage 5 の罠", [{ type: "trap-repeated", stage: "s5", at: NOW }]],
  ] as const)("罠を記録していないコマンド（%s）には、回数によらず出さない", (_, events) => {
    for (const trapJudgements of [0, 2, 3, 4]) {
      expect(stage3TrapHint(events, trapJudgements)).toBe("none");
    }
  });

  it("罠を記録したのに回数が0なら出さない（ありえない入力でも1回目扱いより強くしない）", () => {
    expect(stage3TrapHint([TRAP_TRIGGERED], 0)).toBe("none");
  });
});

describe("countStage3TrapJudgements", () => {
  it.each([
    ["1回目の罠", [TRAP_TRIGGERED], 1],
    ["2回目以降の罠", [TRAP_REPEATED], 1],
    ["罠と他のイベント", [REJECTED, TRAP_REPEATED], 1],
    ["差し戻し", [REJECTED], 0],
    ["クリア", [CLEARED], 0],
    ["Stage 5 の罠", [{ type: "trap-triggered", stage: "s5", at: NOW }], 0],
    ["イベントなし", [], 0],
  ] as const)("%s は %i", (_, events, count) => {
    expect(countStage3TrapJudgements(events)).toBe(count);
  });
});

/** A team that has just entered Stage 3 (built from D1's regular route). */
const atStage3 = (): TeamGameState =>
  teamGameStateSchema.parse({
    ...initialTeamGameState(at(0).at),
    game: enteredStage("s3"),
    enteredAt: { s1: NOW, s2: NOW, s3: NOW },
  });

interface Step {
  state: TeamGameState;
  results: TeamGameResult[];
}

/** Applies each command in turn (all must be applied) and keeps every result. */
const play = (state: TeamGameState, commands: TeamGameCommand[]): Step =>
  commands.reduce<Step>(
    (step, cmd) => {
      const result = applyTeamGameCommand(step.state, cmd, at(0));
      if (result.status !== "applied") throw new Error(`${cmd.type}: ${result.reason}`);
      expect(teamGameStateSchema.safeParse(result.state).success).toBe(true);
      return { state: result.state, results: [...step.results, result] };
    },
    { state, results: [] },
  );

/** The hint each applied result brings, as the server/screen will read it. */
const hintOf = (result: TeamGameResult): Stage3TrapHint =>
  result.status === "applied"
    ? stage3TrapHint(result.events, result.state.s3.trapJudgements)
    : "none";

const trap = (): TeamGameCommand => command("s3.submit", { submission: STAGE3_TRAP });
const short = (): TeamGameCommand =>
  command("s3.submit", { submission: { ...STAGE3_OK, release: "" } });
const pass = (): TeamGameCommand => command("s3.submit", { submission: STAGE3_OK });
const finishPenalty = (): TeamGameCommand => command("s3.finish-penalty");

describe("applyTeamGameCommand: Stage 3 の罠判定を数える（Issue #219）", () => {
  it("初期状態は0回", () => {
    expect(initialTeamGameState(at(0).at).s3).toEqual({ trapJudgements: 0 });
  });

  it("罠 → 罰 → 罠×5: 1=なし、2・3=病型、4=だめ押し、5・6=なし", () => {
    const { state, results } = play(atStage3(), [
      trap(),
      finishPenalty(),
      trap(),
      trap(),
      trap(),
      trap(),
      trap(),
    ]);
    expect(results.map(hintOf)).toEqual([
      "none",
      "none",
      "type-hint",
      "type-hint",
      "final-push",
      "none",
      "none",
    ]);
    expect(results.map((r) => (r.status === "applied" ? r.state.s3.trapJudgements : -1))).toEqual([
      1, 1, 2, 3, 4, 5, 6,
    ]);
    expect(state.s3.trapJudgements).toBe(6);
  });

  it("罠の前の差し戻しは数えない", () => {
    const { state, results } = play(atStage3(), [short(), short(), trap()]);
    expect(results.map(hintOf)).toEqual(["none", "none", "none"]);
    expect(state.s3.trapJudgements).toBe(1);
  });

  it("差し戻しを挟んでも数え直さず、差し戻しでは増えない（罠 → 罰 → 不足 → 罠 は2回目）", () => {
    const { state, results } = play(atStage3(), [trap(), finishPenalty(), short(), trap()]);
    expect(results.map(hintOf)).toEqual(["none", "none", "none", "type-hint"]);
    expect(state.s3.trapJudgements).toBe(2);
  });

  it("クリアでは増えず、ヒントも出さない", () => {
    const { state, results } = play(atStage3(), [trap(), finishPenalty(), trap(), pass()]);
    expect(results.map(hintOf)).toEqual(["none", "none", "type-hint", "none"]);
    expect(state.s3.trapJudgements).toBe(2);
  });

  it("罰の最中に送った罠は拒否され、数えない", () => {
    const { state } = play(atStage3(), [trap()]);
    const result = applyTeamGameCommand(state, trap(), at(0));
    expect(result).toMatchObject({ status: "rejected", reason: "penalty-in-progress" });
    expect(state.s3.trapJudgements).toBe(1);
  });

  it("同じ commandId の再送は D1 が duplicate にするので、数えずヒントも出さない", () => {
    const { state } = play(atStage3(), [trap(), finishPenalty()]);
    const once = trap();
    const first = play(state, [once]);
    const resent = applyTeamGameCommand(first.state, once, at(0));
    expect(resent).toMatchObject({ status: "applied", events: [] });
    expect(hintOf(resent)).toBe("none");
    if (resent.status !== "applied") throw new Error("unreachable");
    expect(resent.state.s3.trapJudgements).toBe(2);
  });
});

describe("teamGameStateSchema: s3.trapJudgements の後方互換と整合", () => {
  /** The state as it was saved before `s3` existed. */
  const withoutS3 = (state: TeamGameState): Record<string, unknown> =>
    Object.fromEntries(Object.entries(state).filter(([key]) => key !== "s3"));

  it("s3 の無い保存済み状態は0回として読める", () => {
    const parsed = teamGameStateSchema.parse(withoutS3(atStage3()));
    expect(parsed.s3).toEqual({ trapJudgements: 0 });
  });

  it.each(["in-progress", "done"] as const)(
    "s3 が無く罠が発動済み（%s）の状態では、発動済みの1回を数えてから足す",
    (penalty) => {
      const fired = play(atStage3(), [trap()]).state;
      const saved = penalty === "done" ? play(fired, [finishPenalty()]).state : fired;
      const legacy = teamGameStateSchema.parse(withoutS3(saved));
      expect(legacy.s3.trapJudgements).toBe(0);
      const ready = penalty === "done" ? legacy : play(legacy, [finishPenalty()]).state;
      // A reject records no trap, so it leaves the count as it was (it does not fill it in).
      expect(play(ready, [short()]).state.s3).toBe(ready.s3);
      const next = play(ready, [trap()]);
      expect(next.state.s3.trapJudgements).toBe(2);
      expect(next.results.map(hintOf).at(-1)).toBe("type-hint");
    },
  );

  it("s3 が無く罠を繰り返した旧状態は1回として数える（既知の限界: 遅れはするが先走らない）", () => {
    const repeated = play(atStage3(), [trap(), finishPenalty(), trap(), trap()]).state;
    const legacy = teamGameStateSchema.parse(withoutS3(repeated));
    const next = play(legacy, [trap()]);
    expect(next.state.s3.trapJudgements).toBe(2);
    expect(next.results.map(hintOf)).toEqual(["type-hint"]);
  });

  it("罠が発動していないのに回数があれば拒否する", () => {
    expect(
      teamGameStateSchema.safeParse({ ...atStage3(), s3: { trapJudgements: 1 } }).success,
    ).toBe(false);
  });

  it.each([
    ["負の数", { trapJudgements: -1 }],
    ["小数", { trapJudgements: 1.5 }],
    ["知らない項目", { trapJudgements: 0, hint: "none" }],
    ["回数なし", {}],
  ])("s3 の形が不正（%s）なら拒否する", (_, s3) => {
    expect(teamGameStateSchema.safeParse({ ...atStage3(), s3 }).success).toBe(false);
  });
});
