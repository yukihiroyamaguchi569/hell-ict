import { FINAL_LINE_MAX, finalHandover, finalLabels, productionImages } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import * as view from "../../../src/stages/final/final-view.js";
import type { FinalPhase } from "../../../src/stages/final/final-view.js";

const GOAL: FinalPhase = { kind: "goal" };
const EPILOGUE: FinalPhase = { kind: "epilogue" };
const DARK: FinalPhase = { kind: "board", lit: 0 };
const ONE: FinalPhase = { kind: "board", lit: 1 };
const ALMOST: FinalPhase = { kind: "board", lit: view.TILE_COUNT - 1 };
const LIT: FinalPhase = { kind: "board", lit: view.TILE_COUNT };
const R0: FinalPhase = { kind: "relay", step: 0 };
const R1: FinalPhase = { kind: "relay", step: 1 };
const R2: FinalPhase = { kind: "relay", step: 2 };
const HANDOVER: FinalPhase = { kind: "handover" };
const REST: FinalPhase = { kind: "rest" };
const ALL = [GOAL, EPILOGUE, DARK, ALMOST, LIT, R0, R1, R2, HANDOVER, REST];

// Each move and where it takes the phases it applies to; every other phase comes back unchanged.
const MOVES: readonly [string, (phase: FinalPhase) => FinalPhase, [FinalPhase, FinalPhase][]][] = [
  ["afterGoal", view.afterGoal, [[GOAL, EPILOGUE]]],
  ["afterEpilogue", view.afterEpilogue, [[EPILOGUE, DARK]]],
  [
    "lightNextTile",
    view.lightNextTile,
    [
      [DARK, ONE],
      [ALMOST, LIT],
    ],
  ],
  [
    "relayBackdrop",
    view.relayBackdrop,
    [
      [R0, R1],
      [R1, R2],
    ],
  ],
  [
    "relayNext",
    view.relayNext,
    [
      [R0, R1],
      [R1, R2],
      [R2, HANDOVER],
    ],
  ],
  ["restart", view.restart, [[HANDOVER, REST]]],
  ["resume", view.resume, [[REST, HANDOVER]]],
];

describe("場面の遷移", () => {
  it.each(MOVES)("%s は決まった遷移先へだけ動き、他の場面は変えない", (_, move, arrows) => {
    for (const phase of ALL) {
      const arrow = arrows.find(([from]) => from === phase);
      if (arrow === undefined) expect(move(phase)).toBe(phase);
      else expect(move(phase)).toEqual(arrow[1]);
    }
  });

  it("リレーは一言のある全点灯のボードからだけ始まり、最後の話者のボタンだけ文言が違う", () => {
    expect(view.startRelay(LIT, "a")).toEqual({ kind: "relay", step: 0 });
    for (const phase of ALL) if (phase !== LIT) expect(view.startRelay(phase, "a")).toBe(phase);
    expect(view.startRelay(LIT, null)).toBe(LIT);
    expect([0, 1, 2].map((step) => view.relayButtonText(step))).toEqual([
      finalLabels.relayNext,
      finalLabels.relayNext,
      finalLabels.relayLast,
    ]);
  });
});

describe("一言・宛名・保存の形", () => {
  it("空白だけは拒否し、前後の空白を落として120字ちょうどまで通す", () => {
    const refused = (note: string) => ({ kind: "refused", note });
    expect(view.checkLine(" 　\n")).toEqual(refused(finalLabels.lineEmpty));
    expect(view.checkLine(` ${"あ".repeat(120)} `)).toEqual({ kind: "ok", line: "あ".repeat(120) });
    expect(view.checkLine("あ".repeat(121))).toEqual(refused(finalLabels.lineTooLong));
  });

  it("宛名とゴールの見出しは、名前が無ければ既定の名で埋める", () => {
    expect(view.handoverAddress("  ")).toBe(finalHandover.teamFallback + "　御中");
    expect(view.goalTeamName("")).toBe("自チーム");
    expect(view.goalTitle("")).toBe("自チーム　ゴール");
    expect(view.goalTitle(" F班 ")).toBe("F班　ゴール");
  });

  it("空白だけの一言、121字の一言、一言の無い未送信は壊れた保存として拒否する", () => {
    const parse = (line: string | null, pending: object | null = null): boolean =>
      view.finalRecordSchema.safeParse({ enteredAt: "x", line, ended: false, pending }).success;
    expect([" ", "あ".repeat(121), "a", null].map((line) => parse(line))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    const commandId = "00000000-0000-4000-8000-000000000001";
    const sent = { commandId, clientAt: "2026-10-31T02:00:00.000Z" };
    expect(parse("a", sent)).toBe(true);
    expect(parse(null, sent)).toBe(false);
    expect(parse("a", { commandId, clientAt: "昨日" })).toBe(false);
  });

  it("UUID でない commandId の未送信は、Worker が拒むので壊れた保存として捨てる", () => {
    const record = (commandId: string) => ({
      enteredAt: "x",
      line: "a",
      ended: false,
      pending: { commandId, clientAt: "2026-10-31T02:00:00.000Z" },
    });
    expect(view.finalRecordSchema.safeParse(record("c")).success).toBe(false);
    expect(view.finalRecordSchema.safeParse(record("")).success).toBe(false);
  });
});

describe("画面の出し分け", () => {
  it("ボードと rest だけが中央ペイン、それ以外は全面の窓", () => {
    expect(ALL.filter((phase) => !view.overlayScene(phase))).toEqual([DARK, ALMOST, LIT, REST]);
  });

  it("点灯数はゴール・エピローグで0、ボードはその数、リレー以降は全部", () => {
    const all = view.TILE_COUNT;
    expect(ALL.map((phase) => view.litTiles(phase))).toEqual([
      0,
      0,
      0,
      all - 1,
      all,
      all,
      all,
      all,
      all,
      all,
    ]);
  });
});

describe("ゴールと感謝状の絵", () => {
  it("どちらも production の画像で、読み込み画面が先読みする", () => {
    const listed = productionImages.map((file) => `/assets/images/production/${file}`);
    expect(view.GOAL_BACKDROP).toBe("/assets/images/production/final-goal-ceremony.webp");
    expect(view.CERTIFICATE_FRAME).toBe("/assets/images/production/final-certificate-frame.webp");
    expect(listed).toContain(view.GOAL_BACKDROP);
    expect(listed).toContain(view.CERTIFICATE_FRAME);
  });
});

describe("感謝状の一言の大きさ", () => {
  const quoteOf = (length: number): string => view.handoverQuote("あ".repeat(length));

  it("「」込みで34字までは大、74字までは中、それより長ければ小", () => {
    expect(view.quoteSize(quoteOf(1))).toBe("large");
    expect(view.quoteSize(quoteOf(32))).toBe("large");
    expect(view.quoteSize(quoteOf(33))).toBe("medium");
    expect(view.quoteSize(quoteOf(72))).toBe("medium");
    expect(view.quoteSize(quoteOf(73))).toBe("small");
  });

  it("上限いっぱいの一言は小、一言が無くても大", () => {
    expect(view.quoteSize(quoteOf(FINAL_LINE_MAX))).toBe("small");
    expect(view.quoteSize(view.handoverQuote(null))).toBe("large");
  });
});
