import { describe, expect, it } from "vitest";

import { applyGameCommand, initialGameState } from "../../src/game/apply-game-command.js";
import { GAME_STAGE_IDS, gameStateSchema, JUDGED_STAGE_IDS } from "../../src/schemas/game.js";
import type { GameCommand, GameState } from "../../src/schemas/game.js";
import {
  advance,
  completePenalty,
  enteredStage,
  judge,
  LATER,
  NOW,
  nextId,
  play,
} from "./helpers.js";

/** Asserts a rejection with no side effect: same state object, no events, id not recorded. */
const expectRejected = (state: GameState, command: GameCommand, reason: string): void => {
  const before = structuredClone(state);
  const result = applyGameCommand(state, command, NOW);
  expect(result.verdict).toEqual({ status: "rejected", reason });
  expect(result.events).toEqual([]);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
  expect(result.state.processedCommandIds).not.toContain(command.commandId);
};

/** A team that has just stepped on the trap of `stage` (penalty running). */
const trapped = (stage: "s3" | "s5"): GameState =>
  play(enteredStage(stage), [judge(stage, "trap")]);

describe("初期状態", () => {
  it("Prologueから、未クリア・罠未使用・処理済みなしで始まり、schemaを満たす", () => {
    const state = initialGameState();
    expect(state).toEqual({
      stage: "prologue",
      clearedAt: {},
      penalties: { s3: "none", s5: "none" },
      processedCommandIds: [],
    });
    expect(gameStateSchema.safeParse(state).success).toBe(true);
  });

  it("呼ぶたびに独立したオブジェクトを返す", () => {
    expect(initialGameState()).not.toBe(initialGameState());
  });
});

describe("許可された遷移", () => {
  it("passでクリア時刻を記録し、stage-clearedを出す（ステージはまだ動かない）", () => {
    const command = judge("prologue", "pass");
    const result = applyGameCommand(initialGameState(), command, NOW);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "stage-cleared", stage: "prologue", at: NOW }]);
    expect(result.state.stage).toBe("prologue");
    expect(result.state.clearedAt).toEqual({ prologue: NOW });
    expect(result.state.processedCommandIds).toEqual([command.commandId]);
  });

  it("クリア済みのステージから次のステージへ1つだけ進み、stage-enteredを出す", () => {
    const cleared = play(initialGameState(), [judge("prologue", "pass")]);
    const result = applyGameCommand(cleared, advance("prologue", "s1"), LATER);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "stage-entered", stage: "s1", at: LATER }]);
    expect(result.state.stage).toBe("s1");
    expect(result.state.clearedAt).toEqual({ prologue: NOW });
  });

  it("PrologueからFinalまで正規ルートで通せ、途中の状態はすべてschemaを満たす", () => {
    let state = initialGameState();
    for (const [index, from] of JUDGED_STAGE_IDS.entries()) {
      const to = GAME_STAGE_IDS[index + 1] ?? "final";
      state = play(state, [judge(from, "pass")]);
      expect(gameStateSchema.safeParse(state).success).toBe(true);
      state = play(state, [advance(from, to)]);
      expect(gameStateSchema.safeParse(state).success).toBe(true);
    }
    expect(state.stage).toBe("final");
    expect(Object.keys(state.clearedAt)).toEqual([...JUDGED_STAGE_IDS]);
    expect(state.processedCommandIds).toHaveLength(JUDGED_STAGE_IDS.length * 2);
  });

  it("rejectは何も変えずsubmission-rejectedだけを出し、commandIdは記録する", () => {
    const state = enteredStage("s2");
    const command = judge("s2", "reject");
    const result = applyGameCommand(state, command, NOW);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "submission-rejected", stage: "s2", at: NOW }]);
    expect(result.state).toEqual({
      ...state,
      processedCommandIds: [...state.processedCommandIds, command.commandId],
    });
  });

  it("rejectの後でもpassでクリアできる", () => {
    const state = play(enteredStage("s4"), [judge("s4", "reject"), judge("s4", "pass")]);
    expect(state.clearedAt.s4).toBe(NOW);
  });

  it("clearedAtにはnowがそのまま入る（時計は引数だけ）", () => {
    const result = applyGameCommand(enteredStage("s1"), judge("s1", "pass"), LATER);
    expect(result.state.clearedAt.s1).toBe(LATER);
  });
});

describe("罠と罰", () => {
  it.each(["s3", "s5"] as const)("%sの最初の罠は罰を開始し、trap-triggeredを出す", (stage) => {
    const state = enteredStage(stage);
    const result = applyGameCommand(state, judge(stage, "trap"), NOW);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "trap-triggered", stage, at: NOW }]);
    expect(result.state.penalties[stage]).toBe("in-progress");
    expect(result.state.clearedAt[stage]).toBeUndefined();
    expect(gameStateSchema.safeParse(result.state).success).toBe(true);
  });

  it("罠を踏んでも、もう一方の罠ステージの状態は変えない", () => {
    expect(trapped("s3").penalties.s5).toBe("none");
    expect(trapped("s5").penalties.s3).toBe("none");
  });

  it.each(["s3", "s5"] as const)("%sの罰を終えるとdoneになり、penalty-completedを出す", (stage) => {
    const result = applyGameCommand(trapped(stage), completePenalty(stage), LATER);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "penalty-completed", stage, at: LATER }]);
    expect(result.state.penalties[stage]).toBe("done");
  });

  it("罰の後はpassでクリアして先へ進める", () => {
    const state = play(trapped("s3"), [
      completePenalty("s3"),
      judge("s3", "pass"),
      advance("s3", "s4"),
    ]);
    expect(state.stage).toBe("s4");
    expect(state.penalties.s3).toBe("done");
  });

  it("2回目の罠は罰を出さずtrap-repeatedだけを出す（連続罰は1回まで）", () => {
    const afterPenalty = play(trapped("s5"), [completePenalty("s5")]);
    const result = applyGameCommand(afterPenalty, judge("s5", "trap"), NOW);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.events).toEqual([{ type: "trap-repeated", stage: "s5", at: NOW }]);
    expect(result.state.penalties.s5).toBe("done");
  });

  it.each(["prologue", "s1", "s2", "s4", "s6"] as const)(
    "罠の無いステージ（%s）へのtrapは拒否する",
    (stage) => {
      expectRejected(enteredStage(stage), judge(stage, "trap"), "trap-not-applicable");
    },
  );
});

describe("禁止された遷移", () => {
  it("未クリアのステージからは進めない", () => {
    expectRejected(initialGameState(), advance("prologue", "s1"), "not-cleared");
    expectRejected(enteredStage("s6"), advance("s6", "final"), "not-cleared");
  });

  it("rejectだけではクリアにならず進めない", () => {
    expectRejected(
      play(enteredStage("s2"), [judge("s2", "reject")]),
      advance("s2", "s3"),
      "not-cleared",
    );
  });

  it("後退は拒否する", () => {
    const state = play(enteredStage("s4"), [judge("s4", "pass")]);
    expectRejected(state, advance("s4", "s3"), "not-forward");
    expectRejected(state, advance("s4", "prologue"), "not-forward");
  });

  it("同じステージへの前進（その場に留まる）も拒否する", () => {
    expectRejected(
      play(enteredStage("s1"), [judge("s1", "pass")]),
      advance("s1", "s1"),
      "not-forward",
    );
  });

  it("Finalからはどこへも進めない", () => {
    const state = enteredStage("final");
    expectRejected(state, advance("final", "final"), "not-forward");
    expectRejected(state, advance("final", "s6"), "not-forward");
  });

  it("ステージを飛ばす前進は拒否する", () => {
    const state = play(enteredStage("s2"), [judge("s2", "pass")]);
    expectRejected(state, advance("s2", "s4"), "skip-forbidden");
    expectRejected(state, advance("s2", "final"), "skip-forbidden");
  });

  it("現在地と違うfromの前進は拒否する（古いタブ・遅れた再送）", () => {
    const state = play(enteredStage("s3"), [judge("s3", "pass")]);
    expectRejected(state, advance("s2", "s3"), "stage-mismatch");
    expectRejected(state, advance("s4", "s5"), "stage-mismatch");
  });

  it("現在地と違うステージの判定は拒否する", () => {
    const state = enteredStage("s3");
    expectRejected(state, judge("s2", "pass"), "stage-mismatch");
    expectRejected(state, judge("s4", "pass"), "stage-mismatch");
    expectRejected(state, judge("s5", "trap"), "stage-mismatch");
  });

  it("クリア済みのステージへの再判定は拒否する（クリア時刻を上書きしない）", () => {
    const state = play(enteredStage("s1"), [judge("s1", "pass")]);
    expectRejected(state, judge("s1", "pass"), "already-cleared");
    expectRejected(state, judge("s1", "reject"), "already-cleared");
  });

  it("クリア済みの罠ステージで罠を踏み直しても罰は始まらない", () => {
    const state = play(enteredStage("s3"), [judge("s3", "pass")]);
    expectRejected(state, judge("s3", "trap"), "already-cleared");
  });
});

describe("罰の実施中（Issue #92）", () => {
  it.each([
    ["s3", "s4"],
    ["s5", "s6"],
  ] as const)("%sの罰の実施中は%sへ進めない", (stage, next) => {
    expectRejected(trapped(stage), advance(stage, next), "penalty-in-progress");
  });

  it.each(["pass", "reject", "trap"] as const)(
    "罰の実施中は判定（%s）を受け付けない",
    (outcome) => {
      expectRejected(trapped("s3"), judge("s3", outcome), "penalty-in-progress");
    },
  );

  it("罰の実施中でも、別ステージを名乗る前進はstage-mismatchで拒否する", () => {
    expectRejected(trapped("s3"), advance("s2", "s3"), "stage-mismatch");
  });

  it("罰の実施中でも、後退・飛ばしは各々の理由で拒否する", () => {
    expectRejected(trapped("s3"), advance("s3", "s2"), "not-forward");
    expectRejected(trapped("s3"), advance("s3", "s5"), "skip-forbidden");
  });
});

describe("罰の完了の禁止", () => {
  it("罰が始まっていなければ完了できない", () => {
    expectRejected(enteredStage("s3"), completePenalty("s3"), "no-penalty-in-progress");
    expectRejected(initialGameState(), completePenalty("s5"), "no-penalty-in-progress");
  });

  it("完了済みの罰を二度完了できない（別のcommandIdでも）", () => {
    const done = play(trapped("s3"), [completePenalty("s3")]);
    expectRejected(done, completePenalty("s3"), "no-penalty-in-progress");
  });

  it("別の罠ステージの罰は完了できない", () => {
    expectRejected(trapped("s3"), completePenalty("s5"), "no-penalty-in-progress");
  });
});

describe("冪等性（同じcommandIdは二度適用しない）", () => {
  it("適用済みのcommandIdはduplicateを返し、状態もイベントも変えない", () => {
    const command = judge("prologue", "pass");
    const first = applyGameCommand(initialGameState(), command, NOW);
    const second = applyGameCommand(first.state, command, LATER);
    expect(second.verdict).toEqual({ status: "duplicate" });
    expect(second.events).toEqual([]);
    expect(second.state).toBe(first.state);
    expect(second.state.clearedAt.prologue).toBe(NOW);
  });

  it("前進の再送は二度進まない", () => {
    const command = advance("prologue", "s1");
    const once = play(initialGameState(), [judge("prologue", "pass"), command]);
    const cleared = play(once, [judge("s1", "pass")]);
    const resent = applyGameCommand(cleared, command, LATER);
    expect(resent.verdict).toEqual({ status: "duplicate" });
    expect(resent.state.stage).toBe("s1");
  });

  it("罠の再送は2回目の罠として数えない", () => {
    const command = judge("s3", "trap");
    const state = play(enteredStage("s3"), [command]);
    const done = play(state, [completePenalty("s3")]);
    const resent = applyGameCommand(done, command, LATER);
    expect(resent.verdict).toEqual({ status: "duplicate" });
    expect(resent.events).toEqual([]);
  });

  it("中身が違っても、同じcommandIdなら適用しない", () => {
    const commandId = nextId();
    const state = play(enteredStage("s2"), [judge("s2", "reject", commandId)]);
    const result = applyGameCommand(state, judge("s2", "pass", commandId), NOW);
    expect(result.verdict).toEqual({ status: "duplicate" });
    expect(result.state.clearedAt.s2).toBeUndefined();
  });

  it("拒否されたcommandIdは記録せず、条件が揃えば同じIDで適用できる", () => {
    const command = advance("prologue", "s1");
    const rejected = applyGameCommand(initialGameState(), command, NOW);
    expect(rejected.verdict).toEqual({ status: "rejected", reason: "not-cleared" });
    const cleared = play(rejected.state, [judge("prologue", "pass")]);
    expect(applyGameCommand(cleared, command, NOW).verdict).toEqual({ status: "applied" });
  });

  it("処理済みcommandIdは適用順に1つずつ積まれる", () => {
    const ids = [nextId(), nextId(), nextId()];
    const state = play(initialGameState(), [
      judge("prologue", "reject", ids[0]),
      judge("prologue", "pass", ids[1]),
      advance("prologue", "s1", ids[2]),
    ]);
    expect(state.processedCommandIds).toEqual(ids);
  });

  // The ids are the only guard for commands that leave the state as is: a resent `reject` or
  // repeated trap would emit its event again once the ids were lost. Position, clear times
  // and penalties are also guarded by matching `from`/`stage` against the current stage.
  it("処理済みcommandIdを失っても、再送で位置・クリア時刻・罰は変わらない", () => {
    const commands: GameCommand[] = [
      judge("prologue", "pass"),
      advance("prologue", "s1"),
      judge("s1", "pass"),
      advance("s1", "s2"),
      judge("s2", "pass"),
      advance("s2", "s3"),
      judge("s3", "trap"),
      completePenalty("s3"),
      judge("s3", "pass"),
      advance("s3", "s4"),
    ];
    const reached = play(initialGameState(), commands);
    const forgotten: GameState = { ...reached, processedCommandIds: [] };
    const replayed = commands.reduce(
      (state, command) => applyGameCommand(state, command, LATER).state,
      forgotten,
    );
    expect(replayed.stage).toBe(reached.stage);
    expect(replayed.clearedAt).toEqual(reached.clearedAt);
    expect(replayed.penalties).toEqual(reached.penalties);
  });

  it("状態を変えないコマンド（reject）は、処理済みcommandIdだけが再送を止める", () => {
    const command = judge("s2", "reject");
    const once = play(enteredStage("s2"), [command]);
    expect(applyGameCommand(once, command, LATER).verdict).toEqual({ status: "duplicate" });
    const forgotten = applyGameCommand({ ...once, processedCommandIds: [] }, command, LATER);
    expect(forgotten.verdict).toEqual({ status: "applied" });
    expect(forgotten.events).toEqual([{ type: "submission-rejected", stage: "s2", at: LATER }]);
  });
});

describe("純粋性", () => {
  it("入力の状態を書き換えない", () => {
    const state = trapped("s3");
    const before = structuredClone(state);
    play(state, [completePenalty("s3"), judge("s3", "pass"), advance("s3", "s4")]);
    expect(state).toEqual(before);
  });

  it("同じ入力には同じ出力を返す", () => {
    const state = enteredStage("s5");
    const command = judge("s5", "trap");
    expect(applyGameCommand(state, command, NOW)).toEqual(applyGameCommand(state, command, NOW));
  });
});
