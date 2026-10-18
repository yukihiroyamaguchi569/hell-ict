import { stage4Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { applyTeamGameCommand, initialTeamGameState } from "../../src/game/team-game.js";
import type { TeamGameResult } from "../../src/game/team-game.js";
import type { GameEvent } from "../../src/schemas/game.js";
import { teamGameStateSchema } from "../../src/schemas/team-game.js";
import type { TeamGameCommand, TeamGameState } from "../../src/schemas/team-game.js";
import {
  countStage4ActionRejects,
  countStage4PatientRejects,
  stage4ActionHint,
  stage4ActionRejectLine,
} from "../../src/stages/s4.js";
import { enteredStage, NOW } from "../game/helpers.js";
import { at, command, STAGE4_ACTION_OK, STAGE4_SUMMARY_OK } from "../game/team-game-fixtures.js";

const REJECTED: GameEvent = { type: "submission-rejected", stage: "s4", at: NOW };
const CLEARED: GameEvent = { type: "stage-cleared", stage: "s4", at: NOW };

describe("stage4ActionHint: 行動提案の差し戻しの通算回数で苅部さんのヒントを選ぶ（Issue #38）", () => {
  it.each([
    [0, "none"],
    [1, "none"],
    [2, "none"],
    [3, "who-hint"],
    [4, "none"],
    [5, "final-push"],
    [6, "none"],
    [7, "none"],
    [20, "none"],
  ] as const)("差し戻し%i回目は %s", (actionRejects, hint) => {
    expect(stage4ActionHint(actionRejects)).toBe(hint);
  });

  it.each([-1, 1.5, Number.NaN])("ありえない回数（%s）では出さない", (actionRejects) => {
    expect(stage4ActionHint(actionRejects)).toBe("none");
  });
});

describe("countStage4ActionRejects", () => {
  it.each([
    ["Stage 4 の差し戻し", [REJECTED], 1],
    ["クリア", [CLEARED], 0],
    ["Stage 3 の差し戻し", [{ type: "submission-rejected", stage: "s3", at: NOW }], 0],
    ["イベントなし（再送）", [], 0],
  ] as const)("%s は %i", (_, events, count) => {
    expect(countStage4ActionRejects(events)).toBe(count);
  });
});

/** A team that has just entered Stage 4 (built from D1's regular route). */
const atStage4 = (): TeamGameState =>
  teamGameStateSchema.parse({
    ...initialTeamGameState(at(0).at),
    game: enteredStage("s4"),
    enteredAt: { s1: NOW, s2: NOW, s3: NOW, s4: NOW },
  });

/** Applies one command and returns the result, checking that an applied state stays valid. */
const step = (state: TeamGameState, cmd: TeamGameCommand): TeamGameResult => {
  const result = applyTeamGameCommand(state, cmd, at(0));
  if (result.status === "applied") {
    expect(teamGameStateSchema.safeParse(result.state).success).toBe(true);
  }
  return result;
};

/** Applies each command in turn (all must be applied). */
const play = (state: TeamGameState, commands: TeamGameCommand[]): TeamGameState =>
  commands.reduce((current, cmd) => {
    const result = step(current, cmd);
    if (result.status !== "applied") throw new Error(`${cmd.type}: ${result.reason}`);
    return result.state;
  }, state);

const summary = (text: string = STAGE4_SUMMARY_OK): TeamGameCommand =>
  command("s4.submit-summary", { text });
const action = (text: string): TeamGameCommand => command("s4.submit-action", { text });

const REJECTED_ACTIONS = [
  stage4Answers.actionAimedAtPatients,
  stage4Answers.actionMissingWhat,
  stage4Answers.actionMissingWhom,
  stage4Answers.actionMissingBoth,
] as const;

describe("applyTeamGameCommand: Stage 4 の行動提案の差し戻しを数える（Issue #38）", () => {
  it("初期状態は0回", () => {
    expect(initialTeamGameState(at(0).at).s4).toEqual({
      summaryAccepted: false,
      actionRejects: 0,
      patientRejects: 0,
    });
  });

  it("どの理由の差し戻しも1回ずつ数え、7回目まで 3回目と5回目だけにヒントがある", () => {
    let state = play(atStage4(), [summary()]);
    const hints: string[] = [];
    for (let i = 0; i < 7; i++) {
      const text = REJECTED_ACTIONS[i % REJECTED_ACTIONS.length] ?? "";
      state = play(state, [action(text)]);
      expect(state.s4.actionRejects).toBe(i + 1);
      hints.push(stage4ActionHint(state.s4.actionRejects));
    }
    expect(hints).toEqual(["none", "none", "who-hint", "none", "final-push", "none", "none"]);
  });

  it("要約の差し戻しは数えない（要約は D1 へ行かない）", () => {
    const state = atStage4();
    const result = step(state, summary(stage4Answers.summaryNg));
    expect(result).toMatchObject({ status: "rejected", reason: "no-ocular-symptom" });
    const passed = play(state, [summary()]);
    expect(passed.s4).toEqual({ summaryAccepted: true, actionRejects: 0, patientRejects: 0 });
  });

  it("要約より先の行動提案は拒否され、数えない", () => {
    const state = atStage4();
    expect(step(state, action(stage4Answers.actionMissingBoth))).toMatchObject({
      status: "rejected",
      reason: "summary-first",
    });
    expect(state.s4.actionRejects).toBe(0);
  });

  it("要約を通したあとの要約の再提出は回数を保つ", () => {
    const rejected = play(atStage4(), [summary(), action(stage4Answers.actionMissingBoth)]);
    // The screen sends no second summary, but the server takes one: it must not reset the count.
    const again = play(rejected, [summary()]);
    expect(again.s4).toEqual({ summaryAccepted: true, actionRejects: 1, patientRejects: 0 });
  });

  it("クリアでは増えない", () => {
    const state = play(atStage4(), [
      summary(),
      action(stage4Answers.actionMissingBoth),
      action(STAGE4_ACTION_OK),
    ]);
    expect(state.s4.actionRejects).toBe(1);
    expect(state.game.clearedAt.s4).toBeDefined();
  });

  it("クリア後の行動提案は拒否され、数えない", () => {
    const cleared = play(atStage4(), [summary(), action(STAGE4_ACTION_OK)]);
    expect(step(cleared, action(stage4Answers.actionMissingBoth))).toMatchObject({
      status: "rejected",
      reason: "already-cleared",
    });
  });

  it("同じ commandId の再送は D1 が duplicate にするので、数えない", () => {
    const state = play(atStage4(), [summary(), action(stage4Answers.actionMissingBoth)]);
    const once = action(stage4Answers.actionMissingWhat);
    const first = play(state, [once]);
    expect(first.s4.actionRejects).toBe(2);
    const resent = step(first, once);
    expect(resent).toMatchObject({ status: "applied", events: [] });
    if (resent.status !== "applied") throw new Error("unreachable");
    expect(resent.state.s4.actionRejects).toBe(2);
  });
});

describe("teamGameStateSchema: s4.actionRejects の後方互換と整合", () => {
  it("actionRejects の無い保存済み状態は0回として読める", () => {
    const passed = play(atStage4(), [summary()]);
    const legacy = teamGameStateSchema.parse({ ...passed, s4: { summaryAccepted: true } });
    expect(legacy.s4).toEqual({ summaryAccepted: true, actionRejects: 0, patientRejects: 0 });
    expect(play(legacy, [action(stage4Answers.actionMissingBoth)]).s4.actionRejects).toBe(1);
  });

  it("要約が通っていないのに回数があれば拒否する", () => {
    expect(
      teamGameStateSchema.safeParse({
        ...atStage4(),
        s4: { summaryAccepted: false, actionRejects: 1 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["負の数", { summaryAccepted: true, actionRejects: -1 }],
    ["小数", { summaryAccepted: true, actionRejects: 1.5 }],
    ["知らない項目", { summaryAccepted: true, actionRejects: 0, hint: "none" }],
    ["要約の可否なし", { actionRejects: 0 }],
  ])("s4 の形が不正（%s）なら拒否する", (_, s4) => {
    expect(teamGameStateSchema.safeParse({ ...atStage4(), s4 }).success).toBe(false);
  });
});

describe("stage4ActionRejectLine: 患者に向けた差し戻しの2回目以降は別の文", () => {
  it.each([
    [1, "aimed-at-patients"],
    [2, "aimed-at-patients-again"],
    [3, "aimed-at-patients-again"],
    [20, "aimed-at-patients-again"],
  ] as const)("患者向けの差し戻し%i回目は %s", (patientRejects, line) => {
    expect(stage4ActionRejectLine("aimed-at-patients", patientRejects)).toBe(line);
  });

  it.each(["missing-what", "missing-whom", "missing-both"] as const)(
    "%s は患者向けの回数によらず理由どおり",
    (reason) => {
      for (const patientRejects of [0, 1, 2, 5]) {
        expect(stage4ActionRejectLine(reason, patientRejects)).toBe(reason);
      }
    },
  );

  it.each([0, -1, Number.NaN])("ありえない回数（%s）では1回目の文", (patientRejects) => {
    expect(stage4ActionRejectLine("aimed-at-patients", patientRejects)).toBe("aimed-at-patients");
  });
});

describe("countStage4PatientRejects", () => {
  it.each([
    ["患者向けの差し戻し", { outcome: "reject", reason: "aimed-at-patients" }, 1, 1],
    ["ほかの理由の差し戻し", { outcome: "reject", reason: "missing-both" }, 1, 0],
    ["通過", { outcome: "pass" }, 0, 0],
    [
      "患者向けでも D1 が記録しなかった（再送）",
      { outcome: "reject", reason: "aimed-at-patients" },
      0,
      0,
    ],
  ] as const)("%s は %i 件の差し戻しのうち %i", (_, judgement, rejects, count) => {
    expect(countStage4PatientRejects(judgement, rejects)).toBe(count);
  });
});

describe("applyTeamGameCommand: 患者に向けた差し戻しを別に数える", () => {
  const PATIENTS = stage4Answers.actionAimedAtPatients;

  it("患者向けの差し戻しだけを数え、ほかの理由が挟まっても2回目から別の文になる", () => {
    let state = play(atStage4(), [summary()]);
    const texts = [
      stage4Answers.actionMissingBoth,
      PATIENTS,
      stage4Answers.actionMissingWhat,
      stage4Answers.actionMissingWhom,
      PATIENTS,
      PATIENTS,
    ];
    const seen: [number, number, string][] = [];
    for (const text of texts) {
      state = play(state, [action(text)]);
      const line =
        text === PATIENTS
          ? stage4ActionRejectLine("aimed-at-patients", state.s4.patientRejects)
          : "-";
      seen.push([state.s4.actionRejects, state.s4.patientRejects, line]);
    }
    expect(seen).toEqual([
      [1, 0, "-"],
      [2, 1, "aimed-at-patients"],
      [3, 1, "-"],
      [4, 1, "-"],
      [5, 2, "aimed-at-patients-again"],
      [6, 3, "aimed-at-patients-again"],
    ]);
  });

  it("同じ commandId の再送は数えない", () => {
    const once = action(PATIENTS);
    const first = play(atStage4(), [summary(), once]);
    expect(first.s4.patientRejects).toBe(1);
    const resent = step(first, once);
    expect(resent).toMatchObject({ status: "applied", events: [] });
    if (resent.status !== "applied") throw new Error("unreachable");
    expect(resent.state.s4).toEqual({ summaryAccepted: true, actionRejects: 1, patientRejects: 1 });
  });

  it("要約より先の患者向けの提案、クリア、クリア後の提案は数えない", () => {
    const early = step(atStage4(), action(PATIENTS));
    expect(early).toMatchObject({ status: "rejected", reason: "summary-first" });
    const cleared = play(atStage4(), [summary(), action(PATIENTS), action(STAGE4_ACTION_OK)]);
    expect(cleared.s4.patientRejects).toBe(1);
    expect(step(cleared, action(`${PATIENTS}。`))).toMatchObject({
      status: "rejected",
      reason: "already-cleared",
    });
  });

  it("要約の再提出は患者向けの回数を保つ", () => {
    const state = play(atStage4(), [summary(), action(PATIENTS), summary()]);
    expect(state.s4).toEqual({ summaryAccepted: true, actionRejects: 1, patientRejects: 1 });
  });
});

describe("teamGameStateSchema: s4.patientRejects の後方互換と整合", () => {
  it("patientRejects の無い保存済み状態は0回として読め、次の患者向けの差し戻しは1回目の文", () => {
    const rejected = play(atStage4(), [summary(), action(stage4Answers.actionAimedAtPatients)]);
    const legacy = teamGameStateSchema.parse({
      ...rejected,
      s4: { summaryAccepted: true, actionRejects: 1 },
    });
    expect(legacy.s4).toEqual({ summaryAccepted: true, actionRejects: 1, patientRejects: 0 });
    const next = play(legacy, [action(`${stage4Answers.actionAimedAtPatients}。`)]);
    expect(next.s4).toEqual({ summaryAccepted: true, actionRejects: 2, patientRejects: 1 });
  });

  it.each([
    ["差し戻しの通算より多い", { summaryAccepted: true, actionRejects: 1, patientRejects: 2 }],
    ["負の数", { summaryAccepted: true, actionRejects: 1, patientRejects: -1 }],
    ["小数", { summaryAccepted: true, actionRejects: 2, patientRejects: 1.5 }],
  ])("s4.patientRejects が不正（%s）なら拒否する", (_, s4) => {
    expect(teamGameStateSchema.safeParse({ ...atStage4(), s4 }).success).toBe(false);
  });

  it("通算と同じ数までは受け入れる", () => {
    const s4 = { summaryAccepted: true, actionRejects: 2, patientRejects: 2 };
    expect(teamGameStateSchema.safeParse({ ...atStage4(), s4 }).success).toBe(true);
  });
});
