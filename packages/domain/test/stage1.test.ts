import { describe, expect, it } from "vitest";

import {
  isStage1Round1Complete,
  judgeStage1Reply,
  stage1EmailStatus,
  stage1Round1Tally,
  STAGE1_ROUND1_DEADLINE_MS,
  STAGE1_ROUND1_EMAILS,
} from "../src/stage1.js";
import type { Stage1Reply } from "../src/schemas/team-state.js";

describe("Stage 1 返信の丁寧さ判定", () => {
  it("25字以上かつ丁寧語を含む返信を通す", () => {
    expect(judgeStage1Reply("承知しました。担当に確認のうえ、折り返しご連絡いたします。")).toBe(
      true,
    );
  });

  it("20字は丁寧語があっても通さない（企画のそっけない側の実例）", () => {
    const text = "承知しました。よろしくお願いいたします。";
    expect(text.length).toBeLessThan(25);
    expect(judgeStage1Reply(text)).toBe(false);
  });

  it("25字以上でも丁寧語が無ければ通さない", () => {
    const text = "了解、対応する。特に問題ないので進めておく、以上で完了とする。";
    expect(text.trim().length).toBeGreaterThanOrEqual(25);
    expect(judgeStage1Reply(text)).toBe(false);
  });

  it("空文字・空白のみは通さない", () => {
    expect(judgeStage1Reply("")).toBe(false);
    expect(judgeStage1Reply("   ")).toBe(false);
  });
});

describe("Stage 1 メールの状態", () => {
  const email = STAGE1_ROUND1_EMAILS[0];
  if (email === undefined) throw new Error("unexpected");
  const roundStartedAt = "2026-08-21T00:00:00.000Z";
  const roundStart = new Date(roundStartedAt).getTime();

  it("締切前は返信が無ければpending", () => {
    const now = new Date(roundStart + email.arrivalOffsetMs);
    expect(stage1EmailStatus(email, [], roundStartedAt, now)).toBe("pending");
  });

  it("締切ちょうどはまだpending、1ms超過でexpired", () => {
    const deadline = roundStart + email.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS;
    expect(stage1EmailStatus(email, [], roundStartedAt, new Date(deadline - 1))).toBe("pending");
    expect(stage1EmailStatus(email, [], roundStartedAt, new Date(deadline))).toBe("expired");
  });

  it("返信済みは締切を過ぎてもrepliedのまま", () => {
    const replies: Stage1Reply[] = [{ emailId: email.id, polite: true }];
    const afterDeadline = new Date(
      roundStart + email.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS + 10_000,
    );
    expect(stage1EmailStatus(email, replies, roundStartedAt, afterDeadline)).toBe("replied");
  });
});

describe("Stage 1 ラウンド1の完了判定と集計", () => {
  const roundStartedAt = "2026-08-21T00:00:00.000Z";
  const roundStart = new Date(roundStartedAt).getTime();
  const lastEmail = STAGE1_ROUND1_EMAILS[STAGE1_ROUND1_EMAILS.length - 1];
  if (lastEmail === undefined) throw new Error("unexpected");
  const afterAllDeadlines = new Date(
    roundStart + lastEmail.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS,
  );

  it("1通でもpendingが残っていれば未完了", () => {
    const early = new Date(roundStart);
    expect(isStage1Round1Complete([], roundStartedAt, early)).toBe(false);
  });

  it("全通がreplied/expiredになれば完了", () => {
    expect(isStage1Round1Complete([], roundStartedAt, afterAllDeadlines)).toBe(true);
  });

  it("返信数と失礼な返信数を集計する", () => {
    const replies: Stage1Reply[] = [
      { emailId: "m1", polite: true },
      { emailId: "m2", polite: false },
      { emailId: "m3", polite: false },
    ];
    expect(stage1Round1Tally(replies)).toEqual({ repliedCount: 3, curtCount: 2 });
  });

  it("返信が無ければ集計は0", () => {
    expect(stage1Round1Tally([])).toEqual({ repliedCount: 0, curtCount: 0 });
  });
});
