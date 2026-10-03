import { describe, expect, it } from "vitest";

import { HANDOVER_STAGE_IDS, teamGameScene } from "../../src/game/scene.js";
import type { SceneFacts, TeamGameScene } from "../../src/game/scene.js";
import { GAME_STAGE_IDS } from "../../src/schemas/game.js";
import type { GameStageId, PenaltyStatus } from "../../src/schemas/game.js";

const AT = "2026-10-31T01:00:00.000Z";
const OPENED = { openedAt: 0, sent: [] };

/** Every judged stage before `stage` is cleared, as the server's states always have it. */
const behind = (stage: GameStageId): Record<string, string> =>
  Object.fromEntries(
    GAME_STAGE_IDS.slice(0, GAME_STAGE_IDS.indexOf(stage))
      .filter((id) => id !== "final")
      .map((id) => [id, AT]),
  );

interface Case {
  readonly stage: GameStageId;
  readonly cleared?: boolean;
  readonly s3?: PenaltyStatus;
  readonly s5?: PenaltyStatus;
  readonly inbox?: unknown;
}

const facts = ({ stage, cleared = false, s3 = "none", s5 = "none", inbox = OPENED }: Case) =>
  ({
    game: {
      stage,
      clearedAt: cleared && stage !== "final" ? { ...behind(stage), [stage]: AT } : behind(stage),
      penalties: { s3, s5 },
    },
    inbox,
  }) satisfies SceneFacts;

describe("teamGameScene: 各ステージ × クリア済みかどうか", () => {
  const table: readonly (readonly [Case, TeamGameScene])[] = [
    [{ stage: "prologue", inbox: null }, { kind: "welcome" }],
    [{ stage: "prologue" }, { kind: "inbox" }],
    // Prologue の終わりはクリア演出なしで Stage 1 へ（受信トレイ側の仕事）。
    [{ stage: "prologue", cleared: true }, { kind: "inbox" }],
    [{ stage: "s1" }, { kind: "stage", stage: "s1" }],
    [
      { stage: "s1", cleared: true },
      { kind: "clear-sequence", stage: "s1", next: "s2", handover: false },
    ],
    [{ stage: "s2" }, { kind: "stage", stage: "s2" }],
    [
      { stage: "s2", cleared: true },
      { kind: "clear-sequence", stage: "s2", next: "s3", handover: true },
    ],
    [{ stage: "s3" }, { kind: "stage", stage: "s3" }],
    [
      { stage: "s3", cleared: true },
      { kind: "clear-sequence", stage: "s3", next: "s4", handover: false },
    ],
    [{ stage: "s4" }, { kind: "stage", stage: "s4" }],
    [
      { stage: "s4", cleared: true },
      { kind: "clear-sequence", stage: "s4", next: "s5", handover: true },
    ],
    [{ stage: "s5" }, { kind: "stage", stage: "s5" }],
    [
      { stage: "s5", cleared: true },
      { kind: "clear-sequence", stage: "s5", next: "s6", handover: false },
    ],
    [{ stage: "s6" }, { kind: "stage", stage: "s6" }],
    [
      { stage: "s6", cleared: true },
      { kind: "clear-sequence", stage: "s6", next: "final", handover: false },
    ],
    [{ stage: "final" }, { kind: "final" }],
  ];

  it.each(table)("%o → %o", (input, scene) => {
    expect(teamGameScene(facts(input))).toEqual(scene);
  });

  it("クリア演出の次のステージは、遊ぶ順のひとつ先", () => {
    for (const stage of ["s1", "s2", "s3", "s4", "s5", "s6"] as const) {
      const scene = teamGameScene(facts({ stage, cleared: true }));
      expect(scene.kind === "clear-sequence" ? scene.next : null).toBe(
        GAME_STAGE_IDS[GAME_STAGE_IDS.indexOf(stage) + 1],
      );
    }
  });

  it("交代の案内を出すのは Stage 2 と Stage 4 のクリア後だけ", () => {
    expect(HANDOVER_STAGE_IDS).toEqual(["s2", "s4"]);
  });
});

describe("teamGameScene: 罰", () => {
  it("罠の罰を払っている間は罰の場面（Stage 3・Stage 5）", () => {
    expect(teamGameScene(facts({ stage: "s3", s3: "in-progress" }))).toEqual({
      kind: "penalty",
      stage: "s3",
    });
    expect(teamGameScene(facts({ stage: "s5", s3: "done", s5: "in-progress" }))).toEqual({
      kind: "penalty",
      stage: "s5",
    });
  });

  it("罰を払い終えたら、そのステージへ戻る", () => {
    expect(teamGameScene(facts({ stage: "s3", s3: "done" }))).toEqual({
      kind: "stage",
      stage: "s3",
    });
    expect(teamGameScene(facts({ stage: "s5", s5: "done" }))).toEqual({
      kind: "stage",
      stage: "s5",
    });
  });

  it("罰を払い終えてからクリアしたら、クリア演出", () => {
    expect(teamGameScene(facts({ stage: "s3", s3: "done", cleared: true }))).toMatchObject({
      kind: "clear-sequence",
      stage: "s3",
    });
  });
});

describe("teamGameScene: サーバが書かない組み合わせでも落ちず、先へ進めない側へ倒す", () => {
  it("罰の最中なのにクリア済み → 罰（advance を送らせない）", () => {
    expect(teamGameScene(facts({ stage: "s3", s3: "in-progress", cleared: true }))).toEqual({
      kind: "penalty",
      stage: "s3",
    });
    expect(teamGameScene(facts({ stage: "s5", s5: "in-progress", cleared: true }))).toEqual({
      kind: "penalty",
      stage: "s5",
    });
  });

  it("よそのステージの罰が走っていても、今のステージの場面を出す", () => {
    expect(teamGameScene(facts({ stage: "s4", s3: "in-progress" }))).toEqual({
      kind: "stage",
      stage: "s4",
    });
    expect(teamGameScene(facts({ stage: "s3", s5: "in-progress" }))).toEqual({
      kind: "stage",
      stage: "s3",
    });
  });

  it("罠の無いステージは罰の値を見ない", () => {
    for (const stage of ["s1", "s2", "s4", "s6"] as const) {
      expect(teamGameScene(facts({ stage, s3: "in-progress", s5: "in-progress" })).kind).toBe(
        "stage",
      );
    }
  });

  it("Final は罰やクリアの記録があっても Final", () => {
    expect(
      teamGameScene({
        game: {
          stage: "final",
          clearedAt: behind("final"),
          penalties: { s3: "in-progress", s5: "in-progress" },
        },
        inbox: null,
      }),
    ).toEqual({ kind: "final" });
  });

  it("Stage 1 以降は受信トレイを開いていなくてもウェルカムに戻らない", () => {
    expect(teamGameScene(facts({ stage: "s1", inbox: null }))).toEqual({
      kind: "stage",
      stage: "s1",
    });
  });

  it("前のステージが未クリアでも、今のステージのクリアだけを見る", () => {
    expect(
      teamGameScene({
        game: { stage: "s4", clearedAt: { s4: AT }, penalties: { s3: "none", s5: "none" } },
        inbox: OPENED,
      }),
    ).toMatchObject({ kind: "clear-sequence", stage: "s4", next: "s5" });
    expect(
      teamGameScene({
        game: { stage: "s4", clearedAt: behind("s5"), penalties: { s3: "none", s5: "none" } },
        inbox: OPENED,
      }),
    ).toMatchObject({ kind: "clear-sequence", stage: "s4" });
    expect(
      teamGameScene({
        game: { stage: "s4", clearedAt: { s5: AT }, penalties: { s3: "none", s5: "none" } },
        inbox: OPENED,
      }),
    ).toEqual({ kind: "stage", stage: "s4" });
  });

  it("入力を書き換えない", () => {
    const input = facts({ stage: "s2", cleared: true });
    const before = structuredClone(input);
    teamGameScene(input);
    expect(input).toEqual(before);
  });
});
