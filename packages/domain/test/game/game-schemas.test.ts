import { describe, expect, it } from "vitest";

import { applyGameCommand, initialGameState } from "../../src/game/apply-game-command.js";
import {
  GAME_STAGE_IDS,
  gameCommandSchema,
  gameEventSchema,
  gameInstantSchema,
  gameStagePosition,
  gameStateSchema,
  gameVerdictSchema,
} from "../../src/schemas/game.js";
import type { GameCommand } from "../../src/schemas/game.js";
import { advance, completePenalty, enteredStage, judge, NOW, nextId, play } from "./helpers.js";

const accepts = (value: unknown): boolean => gameStateSchema.safeParse(value).success;

describe("ステージの並び（モックのposとの対応）", () => {
  it("indexがモックのpos（Prologue=0 … Final=7）と一致する", () => {
    expect(GAME_STAGE_IDS.map(gameStagePosition)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gameStagePosition("prologue")).toBe(0);
    expect(gameStagePosition("s3")).toBe(3);
    expect(gameStagePosition("final")).toBe(7);
  });
});

describe("時刻（gameInstantSchema）", () => {
  it("ISO 8601の日時だけを受け付ける（applyGameCommandのnowはここを通した値に限る）", () => {
    expect(gameInstantSchema.safeParse("2026-10-31T01:00:00.000Z").success).toBe(true);
    for (const value of ["invalid", "", "2026-10-31", "2026-10-31 01:00:00", 0, null]) {
      expect(gameInstantSchema.safeParse(value).success).toBe(false);
    }
  });

  it("通した時刻で遷移した状態・イベントは、読み戻してもschemaを満たす", () => {
    const now = gameInstantSchema.parse(new Date(Date.UTC(2026, 9, 31, 1)).toISOString());
    const result = applyGameCommand(initialGameState(), judge("prologue", "pass"), now);
    expect(gameStateSchema.safeParse(JSON.parse(JSON.stringify(result.state))).success).toBe(true);
    expect(result.events.every((event) => gameEventSchema.safeParse(event).success)).toBe(true);
  });
});

describe("GameStateのschema", () => {
  it("正規ルートで作った状態を受け付ける", () => {
    expect(accepts(initialGameState())).toBe(true);
    expect(accepts(enteredStage("final"))).toBe(true);
    expect(accepts(play(enteredStage("s3"), [judge("s3", "trap")]))).toBe(true);
  });

  it("現在地のステージがクリア済み（advance待ち）でも受け付ける", () => {
    expect(accepts(play(enteredStage("s2"), [judge("s2", "pass")]))).toBe(true);
  });

  it("未知のステージ・余計なキー・壊れた型を拒否する", () => {
    const base = initialGameState();
    expect(accepts({ ...base, stage: "s7" })).toBe(false);
    expect(accepts({ ...base, extra: 1 })).toBe(false);
    expect(accepts({ ...base, penalties: { ...base.penalties, s4: "none" } })).toBe(false);
    expect(accepts({ ...base, clearedAt: { final: NOW } })).toBe(false);
    expect(accepts({ ...base, clearedAt: { prologue: "yesterday" } })).toBe(false);
    expect(accepts({ ...base, processedCommandIds: ["not-a-uuid"] })).toBe(false);
    expect(accepts({ ...base, penalties: { ...base.penalties, s3: "paid" } })).toBe(false);
    expect(accepts(null)).toBe(false);
  });

  it("現在地より前に未クリアのステージがある状態を拒否する", () => {
    const state = enteredStage("s2");
    expect(accepts({ ...state, clearedAt: { prologue: state.clearedAt.prologue } })).toBe(false);
  });

  it("現在地より先にクリア済みのステージがある状態を拒否する", () => {
    const state = enteredStage("s2");
    expect(accepts({ ...state, clearedAt: { ...state.clearedAt, s3: NOW } })).toBe(false);
  });

  it("罠の発動済みフラグを罰と別に持つ旧い形（used: true・罰なし）を拒否する", () => {
    const state = enteredStage("s3");
    expect(
      accepts({
        stage: state.stage,
        clearedAt: state.clearedAt,
        processedCommandIds: state.processedCommandIds,
        traps: { s3: { used: true, penalty: "none" }, s5: { used: false, penalty: "none" } },
      }),
    ).toBe(false);
  });

  it.each(["in-progress", "done"] as const)(
    "現在地より先の罠ステージに罰（%s）がある状態を拒否する",
    (penalty) => {
      const state = enteredStage("s4");
      expect(accepts({ ...state, penalties: { ...state.penalties, s5: penalty } })).toBe(false);
    },
  );

  it("現在地・通過済みの罠ステージの罰の完了は受け付ける", () => {
    const current = enteredStage("s3");
    expect(accepts({ ...current, penalties: { ...current.penalties, s3: "done" } })).toBe(true);
    const passed = enteredStage("s6");
    expect(accepts({ ...passed, penalties: { s3: "done", s5: "done" } })).toBe(true);
  });

  it("罰の実施中に、そのステージを離れている状態を拒否する（Issue #92）", () => {
    const state = enteredStage("s4");
    expect(accepts({ ...state, penalties: { ...state.penalties, s3: "in-progress" } })).toBe(false);
  });

  it("罰の実施中に、そのステージがクリア済みの状態を拒否する", () => {
    const state = play(enteredStage("s5"), [judge("s5", "pass")]);
    expect(accepts({ ...state, penalties: { ...state.penalties, s5: "in-progress" } })).toBe(false);
  });

  it("処理済みcommandIdの重複を拒否する", () => {
    const id = nextId();
    expect(accepts({ ...initialGameState(), processedCommandIds: [id, id] })).toBe(false);
  });
});

describe("GameCommandのschema", () => {
  const commandId = "00000000-0000-4000-8000-00000000abcd";

  it("3種類のコマンドを受け付ける", () => {
    expect(
      gameCommandSchema.safeParse({
        type: "record-judgement",
        commandId,
        stage: "s3",
        judgement: { outcome: "trap" },
      }).success,
    ).toBe(true);
    expect(
      gameCommandSchema.safeParse({ type: "advance", commandId, from: "s6", to: "final" }).success,
    ).toBe(true);
    expect(
      gameCommandSchema.safeParse({ type: "complete-penalty", commandId, stage: "s5" }).success,
    ).toBe(true);
  });

  it("Finalへの判定を拒否する（Finalには判定が無い）", () => {
    expect(
      gameCommandSchema.safeParse({
        type: "record-judgement",
        commandId,
        stage: "final",
        judgement: { outcome: "pass" },
      }).success,
    ).toBe(false);
  });

  it("罠の無いステージの罰の完了を拒否する", () => {
    expect(
      gameCommandSchema.safeParse({ type: "complete-penalty", commandId, stage: "s4" }).success,
    ).toBe(false);
  });

  it("未知のtype・未知のoutcome・未知のステージ・壊れたcommandId・余計なキーを拒否する", () => {
    const invalid: unknown[] = [
      { type: "jump", commandId, to: "final" },
      { type: "record-judgement", commandId, stage: "s1", judgement: { outcome: "win" } },
      {
        type: "record-judgement",
        commandId,
        stage: "s1",
        judgement: { outcome: "pass", score: 1 },
      },
      { type: "advance", commandId, from: "s1", to: "s9" },
      { type: "advance", commandId: "abc", from: "s1", to: "s2" },
      { type: "advance", from: "s1", to: "s2" },
      { type: "advance", commandId, from: "s1", to: "s2", force: true },
    ];
    for (const value of invalid) expect(gameCommandSchema.safeParse(value).success).toBe(false);
  });
});

describe("GameEvent・GameVerdictのschema", () => {
  it("遷移が出すイベントを受け付け、壊れたものを拒否する", () => {
    expect(
      gameEventSchema.safeParse({ type: "stage-entered", stage: "final", at: NOW }).success,
    ).toBe(true);
    expect(
      gameEventSchema.safeParse({ type: "stage-cleared", stage: "final", at: NOW }).success,
    ).toBe(false);
    expect(
      gameEventSchema.safeParse({ type: "trap-triggered", stage: "s4", at: NOW }).success,
    ).toBe(false);
    expect(
      gameEventSchema.safeParse({ type: "stage-entered", stage: "s1", at: "now" }).success,
    ).toBe(false);
  });

  it("拒否の理由は既知の値に限る", () => {
    expect(gameVerdictSchema.safeParse({ status: "rejected", reason: "not-cleared" }).success).toBe(
      true,
    );
    expect(gameVerdictSchema.safeParse({ status: "rejected", reason: "nope" }).success).toBe(false);
    expect(gameVerdictSchema.safeParse({ status: "rejected" }).success).toBe(false);
  });
});

describe("遷移の入出力とschemaの整合", () => {
  it("正規ルート・罠・罰・差し戻し・重複・拒否を通したコマンド・イベント・判定がすべてschemaを満たす", () => {
    const first = judge("prologue", "reject");
    const commands: GameCommand[] = [
      first,
      judge("prologue", "pass"),
      advance("prologue", "s1"),
      judge("s1", "pass"),
      advance("s1", "s2"),
      judge("s2", "pass"),
      advance("s2", "s3"),
      judge("s3", "trap"),
      advance("s3", "s4"),
      completePenalty("s3"),
      judge("s3", "trap"),
      judge("s3", "pass"),
      advance("s3", "s4"),
      judge("s4", "pass"),
      advance("s4", "s5"),
      judge("s5", "trap"),
      completePenalty("s5"),
      judge("s5", "pass"),
      advance("s5", "s6"),
      judge("s6", "pass"),
      advance("s6", "final"),
      first,
    ];
    let state = initialGameState();
    const events = new Set<string>();
    const verdicts = new Set<string>();
    for (const command of commands) {
      expect(gameCommandSchema.safeParse(command).success).toBe(true);
      const result = applyGameCommand(state, command, NOW);
      expect(gameVerdictSchema.safeParse(result.verdict).success).toBe(true);
      for (const event of result.events) {
        expect(gameEventSchema.safeParse(event).success).toBe(true);
        events.add(event.type);
      }
      expect(gameStateSchema.safeParse(result.state).success).toBe(true);
      verdicts.add(result.verdict.status);
      state = result.state;
    }
    expect(state.stage).toBe("final");
    expect([...verdicts].sort()).toEqual(["applied", "duplicate", "rejected"]);
    expect([...events].sort()).toEqual([
      "penalty-completed",
      "stage-cleared",
      "stage-entered",
      "submission-rejected",
      "trap-repeated",
      "trap-triggered",
    ]);
  });
});
