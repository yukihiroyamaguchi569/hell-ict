import {
  gameInstantSchema,
  gameViewResponseSchema,
  INBOX_LIMIT_MS,
  STAGE2_DEADLINE_MS,
} from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  countdown,
  HOT_SECONDS,
  missionFacts,
  remainingSeconds,
} from "../../src/shell/mission-bar-view.js";
import type { MissionDeadline } from "../../src/shell/mission-bar-view.js";
import { START_MS, viewBody } from "../fakes.js";

const AT = gameInstantSchema.parse(new Date(START_MS).toISOString());
const BASE = gameViewResponseSchema.parse(viewBody(0)).state;

const onStage = (
  stage: TeamGameViewState["game"]["stage"],
  rest: Partial<TeamGameViewState> = {},
): TeamGameViewState => ({ ...BASE, ...rest, game: { ...BASE.game, stage } });

const S1: NonNullable<TeamGameViewState["s1"]> = {
  stageStartedAt: START_MS,
  round: 1,
  roundStartedAt: START_MS,
  r3Try: 0,
  doneIds: [],
  curt: [],
  memoReplied: false,
  status: { phase: "playing" },
};

describe("remainingSeconds（残り時間はモックの mmss と同じく切り上げ、0 未満にしない）", () => {
  it.each([
    [10_000, 0, 10],
    [10_000, 1, 10],
    [10_000, 999, 10],
    [10_000, 1_000, 9],
    [10_000, 9_001, 1],
    [10_000, 10_000, 0],
    [10_000, 60_000, 0],
  ])("締切 %d・現在 %d → %d 秒", (at, now, left) => {
    expect(remainingSeconds(at, now)).toBe(left);
  });
});

describe("countdown", () => {
  const plain: MissionDeadline = { at: START_MS + 300_000, label: null, overText: null };
  const withOver: MissionDeadline = { ...plain, label: "7:00 申し送りまで", overText: "締切超過" };

  it("MM:SS で出す", () => {
    expect(countdown(plain, START_MS)).toEqual({ text: "05:00", hot: false, over: false });
    expect(countdown(plain, START_MS + 60_500)).toEqual({ text: "04:00", hot: false, over: false });
  });

  it(`残り ${String(HOT_SECONDS)} 秒から警告色（16 秒では まだ）`, () => {
    expect(countdown(plain, plain.at - 16_000).hot).toBe(false);
    expect(countdown(plain, plain.at - 15_000)).toEqual({ text: "00:15", hot: true, over: false });
    expect(countdown(plain, plain.at - 1)).toEqual({ text: "00:01", hot: true, over: false });
  });

  it("過ぎたら超過の文言へ差し替える（警告色は外す）", () => {
    expect(countdown(withOver, withOver.at)).toEqual({ text: "締切超過", hot: false, over: true });
    expect(countdown(withOver, withOver.at + 90_000).text).toBe("締切超過");
  });

  it("超過の文言が無い締切は 00:00 のまま警告色", () => {
    expect(countdown(plain, plain.at + 5_000)).toEqual({ text: "00:00", hot: true, over: true });
  });

  it("サーバの時計より PC が進んでいても、締切より前なら満額を超えない", () => {
    expect(countdown(plain, START_MS - 10_000).text).toBe("05:10");
  });
});

describe("missionFacts", () => {
  it("受信トレイ：メールを開いている間は、見出し・返信済みの件数・受信トレイの締切", () => {
    const facts = missionFacts({ ...BASE, inbox: { openedAt: START_MS, sent: ["p1"] } }, "p2");
    expect(facts).toEqual({
      title: "Prologue　受信トレイ",
      count: { label: "返信済み", value: "1 / 3" },
      deadline: { at: START_MS + INBOX_LIMIT_MS, label: null, overText: null },
    });
  });

  it("受信トレイ：メールを開いていない（一覧だけ）の間は残り時間を出さない。件数は出す", () => {
    const facts = missionFacts({ ...BASE, inbox: { openedAt: START_MS, sent: [] } }, null);
    expect(facts.deadline).toBeNull();
    expect(facts.count).toEqual({ label: "返信済み", value: "0 / 3" });
  });

  it("受信トレイを開く前は、何かを開いていても件数も締切も無い", () => {
    expect(missionFacts(BASE, "p0")).toMatchObject({ count: null, deadline: null });
  });

  it("Stage 1 は見出しだけ。2回目以降はラウンドの札を付ける（R3 のやり直しで数が進む）", () => {
    expect(missionFacts(onStage("s1"), null)).toEqual({
      title: "Stage 1　平常運転",
      count: null,
      deadline: null,
    });
    expect(missionFacts(onStage("s1", { s1: S1 }), null).title).toBe("Stage 1　平常運転");
    expect(missionFacts(onStage("s1", { s1: { ...S1, round: 2 } }), null).title).toBe(
      "Stage 1　平常運転　（2回目・AIあり）",
    );
    expect(missionFacts(onStage("s1", { s1: { ...S1, round: 3, r3Try: 1 } }), null).title).toBe(
      "Stage 1　平常運転　（3回目・コンテキストあり）",
    );
    expect(missionFacts(onStage("s1", { s1: { ...S1, round: 3, r3Try: 3 } }), null).title).toBe(
      "Stage 1　平常運転　（5回目・コンテキストあり）",
    );
  });

  it("Stage 2 は申し送りまでの締切を持つ。始める前は締切なし", () => {
    expect(missionFacts(onStage("s2"), null).deadline).toBeNull();
    expect(
      missionFacts(onStage("s2", { s2: { startedAt: START_MS, addendumTakenAt: null } }), null),
    ).toEqual({
      title: "Stage 2　火の手",
      count: null,
      deadline: {
        at: START_MS + STAGE2_DEADLINE_MS,
        label: "7:00 申し送りまで",
        overText: "締切超過",
      },
    });
  });

  it.each([
    ["s3", "Stage 3　方針"],
    ["s4", "Stage 4　新情報の解釈"],
    ["s5", "Stage 5　報告"],
    ["s6", "Stage 6　掲示"],
    ["final", "Final　振り返り"],
  ] as const)("%s の見出しは「%s」で、件数も締切も無い", (stage, title) => {
    expect(missionFacts(onStage(stage), null)).toEqual({ title, count: null, deadline: null });
  });

  it("受信トレイの件数と締切は Prologue の間だけ（先へ進んだら出さない）", () => {
    const inbox = { openedAt: START_MS, sent: [] };
    const facts = missionFacts(
      {
        ...onStage("s3", { inbox }),
        game: { ...BASE.game, stage: "s3", clearedAt: { prologue: AT } },
      },
      "p0",
    );
    expect(facts.count).toBeNull();
    expect(facts.deadline).toBeNull();
  });
});
