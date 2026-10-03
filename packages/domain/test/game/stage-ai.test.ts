import { describe, expect, it } from "vitest";

import { initialChatSnapshot } from "../../src/chat.js";
import {
  resolveStageChatTarget,
  stageAiPlan,
  stageAiView,
  stageChatText,
  stageThreadTitle,
} from "../../src/game/stage-ai.js";
import { initialTeamGameState } from "../../src/game/team-game.js";
import type { ChatSnapshot } from "../../src/schemas/chat.js";
import { GAME_STAGE_IDS, gameInstantSchema } from "../../src/schemas/game.js";
import type { GameStageId } from "../../src/schemas/game.js";
import { stageChatCommandSchema } from "../../src/schemas/stage-chat.js";
import type { StageChatCommand } from "../../src/schemas/stage-chat.js";
import { teamCodeSchema } from "../../src/schemas/team-state.js";
import type { TeamGameState } from "../../src/schemas/team-game.js";
import {
  acknowledgeStage1RoundResult,
  settleStage1Round,
  startStage1,
} from "../../src/stages/s1.js";
import type { Stage1State } from "../../src/stages/s1.js";

const MAIN = "00000000-0000-4000-8000-000000000001";
const STAGE3 = "00000000-0000-4000-8000-000000000003";
const MANUAL = "00000000-0000-4000-8000-000000000009";

const base = initialChatSnapshot(teamCodeSchema.parse("123456"), MAIN);

const withThreads = (
  ...threads: { threadId: string; title: string; kind?: "stage" | "manual" }[]
): ChatSnapshot => ({
  ...base,
  threads: [...base.threads, ...threads.map((thread) => ({ ...thread, messages: [] }))],
});

const message = (text = "質問です"): StageChatCommand =>
  stageChatCommandSchema.parse({
    type: "stage-message",
    commandId: crypto.randomUUID(),
    generation: 0,
    text,
  });

const draft = (payload: { mailId: string; context?: string; point?: string }): StageChatCommand =>
  stageChatCommandSchema.parse({
    type: "s1-draft",
    commandId: crypto.randomUUID(),
    generation: 0,
    context: "",
    point: "",
    ...payload,
  });

describe("ステージごとのAI（モックの STAGE_THREAD_TITLES・sendAI・s1DraftLive）", () => {
  it("会話は Stage 2〜6 が自分のスレッド、Stage 1 はメイン、Prologue と Final は無し", () => {
    expect(GAME_STAGE_IDS.map((stage) => [stage, stageThreadTitle(stage)])).toEqual([
      ["prologue", null],
      ["s1", null],
      ["s2", "Stage 2"],
      ["s3", "Stage 3"],
      ["s4", "Stage 4"],
      ["s5", "Stage 5"],
      ["s6", "Stage 6"],
      ["final", null],
    ]);
  });

  it("AIへ送るのは Stage 1 の下書き（s1）と Stage 3〜5 の会話。Stage 3 だけが罠のプロンプト（s3）", () => {
    expect(GAME_STAGE_IDS.map((stage) => [stage, stageAiPlan(stage)?.live ?? null])).toEqual([
      ["prologue", null],
      ["s1", { command: "s1-draft", profile: "s1" }],
      ["s2", null],
      ["s3", { command: "stage-message", profile: "s3" }],
      ["s4", { command: "stage-message", profile: "default" }],
      ["s5", { command: "stage-message", profile: "default" }],
      ["s6", null],
      ["final", null],
    ]);
  });
});

describe("GETに載せる今のステージのAI", () => {
  it("Prologue と Final はAIが無い", () => {
    for (const stage of ["prologue", "final"] as const) {
      expect(stageAiView(stage, withThreads())).toEqual({ status: "none" });
    }
  });

  it("Stage 1 はメインの会話（先頭）を、AIへ送るステージとして示す", () => {
    expect(stageAiView("s1", withThreads())).toEqual({
      status: "ready",
      threadId: MAIN,
      live: true,
    });
  });

  it("ステージの会話があればそれを示す。Stage 2・6 はAIへ送らない", () => {
    const snapshot = withThreads(
      { threadId: STAGE3, title: "Stage 3", kind: "stage" },
      { threadId: MANUAL, title: "Stage 2", kind: "stage" },
      { threadId: crypto.randomUUID(), title: "Stage 6", kind: "stage" },
    );
    expect(stageAiView("s3", snapshot)).toEqual({ status: "ready", threadId: STAGE3, live: true });
    expect(stageAiView("s2", snapshot)).toEqual({ status: "ready", threadId: MANUAL, live: false });
    expect(stageAiView("s6", snapshot)).toMatchObject({ status: "ready", live: false });
  });

  it("ステージの会話が無ければ失敗を示し、前のステージの会話を代わりに出さない（#85）", () => {
    const snapshot = withThreads({ threadId: STAGE3, title: "Stage 3", kind: "stage" });
    expect(stageAiView("s4", snapshot)).toEqual({ status: "failed" });
  });

  it("同名でも参加者の手動スレッド（kind 無し・manual）はステージの会話とみなさない", () => {
    const snapshot = withThreads(
      { threadId: MANUAL, title: "Stage 3" },
      { threadId: crypto.randomUUID(), title: "Stage 3", kind: "manual" },
    );
    expect(stageAiView("s3", snapshot)).toEqual({ status: "failed" });
  });
});

describe("会話の送り先はステージだけで決まる", () => {
  const snapshot = withThreads(
    { threadId: MANUAL, title: "Stage 3", kind: "manual" },
    { threadId: STAGE3, title: "Stage 3", kind: "stage" },
  );

  it("Stage 3 の会話は Stage 3 のスレッドへ、罠のプロンプトで", () => {
    expect(resolveStageChatTarget("s3", snapshot, "stage-message")).toEqual({
      ok: true,
      threadId: STAGE3,
      promptProfile: "s3",
    });
  });

  it("Stage 1 の下書きはメインへ、s1 のプロンプトで", () => {
    expect(resolveStageChatTarget("s1", snapshot, "s1-draft")).toEqual({
      ok: true,
      threadId: MAIN,
      promptProfile: "s1",
    });
  });

  it.each([
    ["prologue", "stage-message"],
    ["s1", "stage-message"],
    ["s2", "stage-message"],
    ["s3", "s1-draft"],
    ["s6", "stage-message"],
    ["final", "stage-message"],
  ] as const)("%s の %s はAIへ送らない", (stage, type) => {
    expect(resolveStageChatTarget(stage, snapshot, type)).toEqual({
      ok: false,
      reason: "no-ai-chat",
    });
  });

  it.each(["s4", "s5"] as const)(
    "%s の会話が無ければ送らない（前のステージの会話へ落とさない）",
    (stage) => {
      expect(resolveStageChatTarget(stage, snapshot, "stage-message")).toEqual({
        ok: false,
        reason: "thread-not-ready",
      });
    },
  );
});

describe("AIへ送る本文", () => {
  const T0 = Date.parse("2026-10-31T01:00:00.000Z");
  const R2_START = T0 + 100_000;
  const game = (s1: Stage1State | null, stage: GameStageId = "s1"): TeamGameState => ({
    ...initialTeamGameState(gameInstantSchema.parse(new Date(T0).toISOString())),
    s1,
    game: {
      ...initialTeamGameState(gameInstantSchema.parse(new Date(T0).toISOString())).game,
      stage,
    },
  });
  const round2 = (): Stage1State => {
    const ended = settleStage1Round(startStage1(T0), T0 + 85_001).state;
    const next = acknowledgeStage1RoundResult(ended, R2_START);
    if (next === null) throw new Error("no result window");
    return next;
  };
  const context = "前任ICNの引き継ぎメモ";

  it("会話はそのまま送る", () => {
    expect(stageChatText(game(null, "s3"), message("質問です"), T0)).toEqual({
      ok: true,
      text: "質問です",
    });
  });

  it("下書きは Stage 1 を始める前には送らない", () => {
    expect(stageChatText(game(null), draft({ mailId: "r1", point: "x" }), T0)).toEqual({
      ok: false,
      reason: "not-started",
    });
  });

  it("R1 では下書きさせない（AIが無いラウンド）", () => {
    expect(stageChatText(game(startStage1(T0)), draft({ mailId: "m1", point: "x" }), T0)).toEqual({
      ok: false,
      reason: "no-ai",
    });
  });

  it.each([
    ["材料が無い", { mailId: "r1" }, R2_START, "no-material"],
    ["着弾前", { mailId: "r2", point: "x" }, R2_START, "not-landed"],
    ["別ラウンドのメール", { mailId: "t1", point: "x" }, R2_START, "not-in-round"],
    ["期限切れ", { mailId: "r1", point: "x" }, R2_START + 62_001, "expired"],
  ])("%s の下書きは送らない", (_name, payload, now, reason) => {
    expect(stageChatText(game(round2()), draft(payload), now)).toEqual({ ok: false, reason });
  });

  it("要点だけなら要点で下書きさせる（参考資料を付けない）", () => {
    const result = stageChatText(
      game(round2()),
      draft({ mailId: "r1", point: "総務課" }),
      R2_START,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.text).toContain("【要点】\n総務課");
    expect(result.ok && result.text).not.toContain("【参考資料】");
  });

  it("コンテキストがあれば参考資料として付ける", () => {
    const result = stageChatText(game(round2()), draft({ mailId: "r1", context }), R2_START);
    expect(result.ok && result.text).toContain(`【参考資料】\n${context}`);
  });

  it("コンテキストが1字でも、要点より優先して参考資料として付ける（PR #266 で変更。100字の条件は廃止）", () => {
    const result = stageChatText(
      game(round2()),
      draft({ mailId: "r1", context: "引", point: "総務課" }),
      R2_START,
    );
    expect(result.ok && result.text).toContain("【参考資料】\n引\n\n");
    expect(result.ok && result.text).toContain("【要点】\n総務課");
  });

  it("空白だけのコンテキストは付けず、要点で下書きさせる", () => {
    const result = stageChatText(
      game(round2()),
      draft({ mailId: "r1", context: " \n ", point: "総務課" }),
      R2_START,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.text).not.toContain("【参考資料】");
  });

  it("空白だけのコンテキストと空の要点は no-material", () => {
    expect(
      stageChatText(game(round2()), draft({ mailId: "r1", context: " \n " }), R2_START),
    ).toEqual({ ok: false, reason: "no-material" });
  });
});
