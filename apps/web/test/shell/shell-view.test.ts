import { GAME_STAGE_IDS, PENALTY_STATUSES } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  clockText,
  feverCount,
  fitScale,
  rightPaneAttrs,
  shellView,
  type ShellFacts,
  type ShellView,
} from "../../src/shell/shell-view.js";

const facts = (overrides: Partial<ShellFacts> & Pick<ShellFacts, "stage">): ShellFacts => ({
  cleared: false,
  s3Penalty: "none",
  inboxOpened: true,
  rightOverride: null,
  ...overrides,
});

/**
 * The expected frame per stage, cleared or not, taken from the mock's go() and effects
 * (hell-ict-archive:docs/ui/mock/index.html). The pane columns assume the inbox is open and the Stage 2 AI pane
 * not yet revealed; those two facts have their own tests below.
 */
const table: readonly (readonly [ShellFacts["stage"], boolean, Omit<ShellView, "stage">])[] = [
  [
    "prologue",
    false,
    { mode: "peace", fever: 3, crescendo: false, left: "shown", right: "collapsed" },
  ],
  [
    "prologue",
    true,
    { mode: "peace", fever: 3, crescendo: false, left: "shown", right: "collapsed" },
  ],
  ["s1", false, { mode: "peace", fever: 3, crescendo: false, left: "shown", right: "collapsed" }],
  ["s1", true, { mode: "peace", fever: 3, crescendo: false, left: "shown", right: "collapsed" }],
  ["s2", false, { mode: "alert", fever: 3, crescendo: false, left: "shown", right: "collapsed" }],
  ["s2", true, { mode: "alert", fever: 5, crescendo: false, left: "shown", right: "shown" }],
  ["s3", false, { mode: "crisis", fever: 9, crescendo: true, left: "shown", right: "shown" }],
  ["s3", true, { mode: "crisis", fever: 9, crescendo: true, left: "shown", right: "shown" }],
  ["s4", false, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["s4", true, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["s5", false, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["s5", true, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["s6", false, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["s6", true, { mode: "crisis", fever: 14, crescendo: true, left: "shown", right: "shown" }],
  ["final", false, { mode: "peace", fever: 0, crescendo: false, left: "shown", right: "hidden" }],
];

describe("shellView", () => {
  it.each(table)("%s（クリア済み=%s）", (stage, cleared, expected) => {
    expect(shellView(facts({ stage, cleared }))).toEqual({ stage, ...expected });
  });

  it("表はすべてのステージを覆う", () => {
    expect([...new Set(table.map(([stage]) => stage))]).toEqual([...GAME_STAGE_IDS]);
  });

  describe("発熱インジケータ", () => {
    it("Stage 2 はクリア前 3、クリア後 5", () => {
      expect(feverCount(facts({ stage: "s2" }))).toBe(3);
      expect(feverCount(facts({ stage: "s2", cleared: true }))).toBe(5);
    });

    it.each(["in-progress", "done"] as const)(
      "Stage 3 は罠が発火したら（罰=%s）クリアの前後とも 12",
      (s3Penalty) => {
        expect(feverCount(facts({ stage: "s3", s3Penalty }))).toBe(12);
        expect(feverCount(facts({ stage: "s3", s3Penalty, cleared: true }))).toBe(12);
      },
    );

    it("Stage 3 の罠の 12 は Stage 4 へ持ち越さず、入場の急増後の 14 になる", () => {
      for (const stage of ["s4", "s5", "s6"] as const) {
        expect(feverCount(facts({ stage, s3Penalty: "done" }))).toBe(14);
      }
    });

    it("Final は罰の状態によらず発熱 0 の peace", () => {
      for (const s3Penalty of PENALTY_STATUSES) {
        expect(shellView(facts({ stage: "final", s3Penalty }))).toMatchObject({
          mode: "peace",
          fever: 0,
          crescendo: false,
        });
      }
    });

    it("Stage 3 より前のステージは罰の状態で値が動かない", () => {
      for (const stage of ["prologue", "s1", "s2"] as const) {
        for (const cleared of [false, true]) {
          const base = feverCount(facts({ stage, cleared }));
          for (const s3Penalty of PENALTY_STATUSES) {
            expect(feverCount(facts({ stage, cleared, s3Penalty }))).toBe(base);
          }
        }
      }
    });
  });

  describe("ペインの可視性", () => {
    it("ウェルカム（受信トレイを開く前）は左右とも出さない", () => {
      expect(shellView(facts({ stage: "prologue", inboxOpened: false }))).toMatchObject({
        left: "hidden",
        right: "hidden",
      });
    });

    it("受信トレイを開いた後の Prologue は、左を出して右は畳んでおく", () => {
      expect(shellView(facts({ stage: "prologue", inboxOpened: true }))).toMatchObject({
        left: "shown",
        right: "collapsed",
      });
    });

    it("ステージが右ペインの見え方を上書きしたら、それに従う（Stage 2 のAI解禁）", () => {
      expect(shellView(facts({ stage: "s2", rightOverride: "shown" })).right).toBe("shown");
      for (const stage of GAME_STAGE_IDS) {
        for (const right of ["hidden", "collapsed", "shown"] as const) {
          expect(shellView(facts({ stage, rightOverride: right })).right, stage).toBe(right);
        }
      }
    });

    it("上書きしても左ペインと枠の色・熱は変わらない", () => {
      for (const stage of GAME_STAGE_IDS) {
        const overridden = shellView(facts({ stage, rightOverride: "hidden" }));
        expect(overridden, stage).toEqual({ ...shellView(facts({ stage })), right: "hidden" });
      }
    });

    it("ウェルカム（受信トレイを開く前）は、上書きがあってもペインを出さない", () => {
      const welcome = facts({ stage: "prologue", inboxOpened: false, rightOverride: "shown" });
      expect(shellView(welcome).right).toBe("hidden");
    });

    it("受信トレイの事実は Prologue 以外のステージの左右を動かさない", () => {
      for (const stage of GAME_STAGE_IDS.filter((id) => id !== "prologue")) {
        const opened = shellView(facts({ stage, inboxOpened: true }));
        const closed = shellView(facts({ stage, inboxOpened: false }));
        expect([closed.left, closed.right]).toEqual([opened.left, opened.right]);
      }
    });
  });
});

describe("rightPaneAttrs", () => {
  it("畳んだ右ペインは読み上げからもキーボードのフォーカスからも外す", () => {
    expect(rightPaneAttrs("collapsed")).toEqual({ "aria-hidden": "true", inert: true });
  });

  it.each(["shown", "hidden"] as const)("%s の右ペインには属性を付けない", (right) => {
    expect(rightPaneAttrs(right)).toEqual({});
  });
});

describe("clockText", () => {
  it.each([
    [null, "--:--"],
    [Number.NaN, "--:--"],
    [Number.POSITIVE_INFINITY, "--:--"],
    [0, "00:00"],
    [999, "00:00"],
    [1_000, "00:01"],
    [59_999, "00:59"],
    [60_000, "01:00"],
    [599_000, "09:59"],
    [7_200_000, "120:00"],
    [-5_000, "00:00"],
  ] as const)("%s ms → %s", (elapsedMs, expected) => {
    expect(clockText(elapsedMs)).toBe(expected);
  });
});

describe("fitScale", () => {
  it.each([
    [1280, 1],
    [2560, 1],
    [640, 0.5],
    [1279, 1279 / 1280],
    [0, 1],
    [-10, 1],
  ] as const)("幅 %s → %s", (width, expected) => {
    expect(fitScale(width)).toBe(expected);
  });
});
