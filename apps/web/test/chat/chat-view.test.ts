import { chatSnapshotSchema } from "@hell-ict/domain";
import type { ChatSnapshot, StageAi } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  chatPaneMode,
  newerSnapshot,
  replyParts,
  showsPrepareFailure,
  stageThreadMessages,
} from "../../src/chat/chat-view.js";
import { chatMessageBody, chatSnapshotBody } from "../fakes.js";

const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";

const snapshot = (revision: number, teamCode = "123456"): ChatSnapshot =>
  chatSnapshotSchema.parse({
    ...chatSnapshotBody(revision, {
      [S2]: [chatMessageBody(1, "user", "前のステージの質問")],
      [S3]: [chatMessageBody(2, "user", "斑紋症は？"), chatMessageBody(3, "assistant", "回答")],
    }),
    teamCode,
  });

const ready = (threadId: string, live = true): StageAi => ({ status: "ready", threadId, live });

describe("chatPaneMode", () => {
  it.each<[StageAi, string]>([
    [{ status: "none" }, "none"],
    [ready(S3, true), "live"],
    [ready(S2, false), "scripted"],
    [{ status: "failed" }, "failed"],
  ])("%j → %s", (ai, mode) => {
    expect(chatPaneMode(ai)).toBe(mode);
  });
});

describe("showsPrepareFailure", () => {
  it("サーバの会話の準備に失敗したら［再試行］を出す。台本で答えるステージでは出さない", () => {
    expect(showsPrepareFailure("failed", false)).toBe(true);
    expect(showsPrepareFailure("failed", true)).toBe(false);
    for (const mode of ["none", "live", "scripted"] as const) {
      expect(showsPrepareFailure(mode, false)).toBe(false);
    }
  });
});

describe("stageThreadMessages", () => {
  it("ready なら、その threadId の会話だけを返す", () => {
    expect(stageThreadMessages(snapshot(1), ready(S3)).map((m) => m.text)).toEqual([
      "斑紋症は？",
      "回答",
    ]);
  });

  it("別のステージのスレッドの会話は混ぜない", () => {
    expect(stageThreadMessages(snapshot(1), ready(S2)).map((m) => m.text)).toEqual([
      "前のステージの質問",
    ]);
  });

  it("live でない（台本の）ステージでも、そのスレッドの会話を返す", () => {
    expect(stageThreadMessages(snapshot(1), ready(S3, false))).toHaveLength(2);
  });

  it("スレッドがまだ無ければ空で、ほかのスレッドへ落ちない", () => {
    expect(stageThreadMessages(snapshot(1), ready(S4))).toEqual([]);
  });

  it.each<[string, StageAi]>([
    ["none", { status: "none" }],
    ["failed", { status: "failed" }],
  ])("%s なら会話があっても空", (_label, ai) => {
    expect(stageThreadMessages(snapshot(1), ai)).toEqual([]);
  });

  it("チャットをまだ読んでいなければ空", () => {
    expect(stageThreadMessages(null, ready(S3))).toEqual([]);
  });
});

describe("newerSnapshot", () => {
  it("手元に無ければ届いたものを採る", () => {
    const next = snapshot(0);
    expect(newerSnapshot(null, next)).toBe(next);
  });

  it("revision が新しければ採る", () => {
    const next = snapshot(3);
    expect(newerSnapshot(snapshot(2), next)).toBe(next);
  });

  it("revision が同じなら届いたものを採る（commands の答えを持つことがある）", () => {
    const next = snapshot(2);
    expect(newerSnapshot(snapshot(2), next)).toBe(next);
  });

  it("revision が古い応答は捨てて手元を残す", () => {
    const current = snapshot(5);
    expect(newerSnapshot(current, snapshot(4))).toBe(current);
  });

  it("revision 0 の応答も、手元が 1 なら捨てる", () => {
    const current = snapshot(1);
    expect(newerSnapshot(current, snapshot(0))).toBe(current);
  });

  it("別のチームのチャットは revision によらず採る", () => {
    const next = snapshot(0, "654321");
    expect(newerSnapshot(snapshot(9), next)).toBe(next);
  });
});

describe("replyParts", () => {
  it("タブの無い応答は全部が導入文", () => {
    expect(replyParts("こんにちは\n2行目")).toEqual({
      lead: ["こんにちは", "2行目"],
      table: null,
    });
  });

  it("最初にタブを含む行から下を表にし、タブと改行をそのまま保つ", () => {
    expect(replyParts("整形しました。\n\n氏名\t体温\nA\t38.1\n以上です。")).toEqual({
      lead: ["整形しました。", ""],
      table: "氏名\t体温\nA\t38.1\n以上です。",
    });
  });

  it("1行目からタブがあれば導入文は無い", () => {
    expect(replyParts("a\tb\nc\td")).toEqual({ lead: [], table: "a\tb\nc\td" });
  });

  it("最後の行だけにタブがあっても、その行から表", () => {
    expect(replyParts("前置き\nx\ty")).toEqual({ lead: ["前置き"], table: "x\ty" });
  });

  it("空の文字列は空の導入文1行", () => {
    expect(replyParts("")).toEqual({ lead: [""], table: null });
  });

  it("タブだけの応答も表", () => {
    expect(replyParts("\t")).toEqual({ lead: [], table: "\t" });
  });
});
