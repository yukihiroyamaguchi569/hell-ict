import { describe, expect, it } from "vitest";

import { teamCodeSchema, teamCommandSchema } from "../src/schemas/team-state.js";
import type { TeamSnapshot } from "../src/schemas/team-state.js";
import { STAGE1_ROUND1_DEADLINE_MS } from "../src/stage1.js";
import { initialTeamSnapshot, transitionTeam } from "../src/team-state.js";

describe("最小チーム状態", () => {
  it("先頭ゼロを含む6桁コードだけを受け入れる", () => {
    expect(teamCodeSchema.parse("000000")).toBe("000000");
    expect(teamCodeSchema.parse("999999")).toBe("999999");
    for (const invalid of ["12345", "1234567", "１２３４５６", " 123456", "abc123"]) {
      expect(teamCodeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("prologueからstage1へ一度だけ進める", () => {
    const initial = initialTeamSnapshot("000001");
    const command = teamCommandSchema.parse({
      type: "enter-stage1",
      commandId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
    });
    const now = new Date("2026-08-21T00:00:00.000Z");
    const transitioned = transitionTeam(initial, command, now);
    expect(transitioned).toEqual({
      ok: true,
      snapshot: {
        ...initial,
        revision: 1,
        state: {
          ...initial.state,
          stage: "stage1",
          stage1: { roundStartedAt: now.toISOString(), replies: [] },
        },
      },
    });
    expect(transitionTeam(initial, { ...command, expectedRevision: -1 }, now)).toEqual({
      ok: false,
      reason: "revision-conflict",
    });
    const stage1 = (transitioned as { ok: true; snapshot: typeof initial }).snapshot;
    expect(transitionTeam(stage1, command, now)).toEqual({
      ok: false,
      reason: "revision-conflict",
    });
    expect(transitionTeam(stage1, { ...command, expectedRevision: 1 }, now)).toEqual({
      ok: false,
      reason: "forbidden-transition",
    });
  });

  it("未知のフィールド、配列、null、非整数revisionを拒否する", () => {
    for (const input of [
      null,
      [],
      {
        type: "enter-stage1",
        commandId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: 0,
        extra: true,
      },
      {
        type: "enter-stage1",
        commandId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: 0.5,
      },
    ]) {
      expect(teamCommandSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("Stage 1 ラウンド1の返信コマンド", () => {
  const roundStartedAt = "2026-08-21T00:00:00.000Z";
  const stage1Snapshot = (): TeamSnapshot => ({
    teamCode: "000002",
    revision: 0,
    state: {
      mode: "peace",
      stage: "stage1",
      metrics: { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 },
      stage1: { roundStartedAt, replies: [] },
    },
  });
  const replyCommand = (overrides: Partial<Record<string, unknown>> = {}) =>
    teamCommandSchema.parse({
      type: "submit-stage1-reply",
      commandId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 0,
      emailId: "m1",
      text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
      ...overrides,
    });

  it("丁寧な返信をpolite:trueで記録する", () => {
    const snapshot = stage1Snapshot();
    const command = replyCommand();
    const now = new Date(roundStartedAt);
    const result = transitionTeam(snapshot, command, now);
    expect(result).toEqual({
      ok: true,
      snapshot: {
        ...snapshot,
        revision: 1,
        state: {
          ...snapshot.state,
          stage1: { roundStartedAt, replies: [{ emailId: "m1", polite: true }] },
        },
      },
    });
  });

  it("失礼な返信も送信自体は成功し、polite:falseで記録する", () => {
    const snapshot = stage1Snapshot();
    const command = replyCommand({ text: "承知しました。" });
    const result = transitionTeam(snapshot, command, new Date(roundStartedAt));
    expect(result).toEqual({
      ok: true,
      snapshot: {
        ...snapshot,
        revision: 1,
        state: {
          ...snapshot.state,
          stage1: { roundStartedAt, replies: [{ emailId: "m1", polite: false }] },
        },
      },
    });
  });

  it("空文字の返信をschemaレベルで拒否する", () => {
    expect(
      teamCommandSchema.safeParse({
        type: "submit-stage1-reply",
        commandId: "00000000-0000-4000-8000-000000000002",
        expectedRevision: 0,
        emailId: "m1",
        text: "   ",
      }).success,
    ).toBe(false);
  });

  it("締切超過後の返信をemail-expiredで拒否する", () => {
    const snapshot = stage1Snapshot();
    const command = replyCommand();
    const afterDeadline = new Date(new Date(roundStartedAt).getTime() + STAGE1_ROUND1_DEADLINE_MS);
    expect(transitionTeam(snapshot, command, afterDeadline)).toEqual({
      ok: false,
      reason: "email-expired",
    });
  });

  it("存在しないemailIdをschemaレベルで拒否する", () => {
    expect(
      teamCommandSchema.safeParse({
        type: "submit-stage1-reply",
        commandId: "00000000-0000-4000-8000-000000000002",
        expectedRevision: 0,
        emailId: "m11",
        text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
      }).success,
    ).toBe(false);
  });

  it("schema/データ間の不整合を想定し、domain側もunknown-emailで防御する", () => {
    // 本来はschemaのz.enumがemailIdを絞るため通常経路では発生しないが、
    // STAGE1_ROUND1_EMAILSとschemaの列挙が将来ずれた場合の防御をschemaを経由せず検証する。
    const snapshot = stage1Snapshot();
    const command = {
      type: "submit-stage1-reply" as const,
      commandId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 0,
      emailId: "m11" as unknown as "m1",
      text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
    };
    expect(transitionTeam(snapshot, command, new Date(roundStartedAt))).toEqual({
      ok: false,
      reason: "unknown-email",
    });
  });

  it("同じメールへの二重返信をalready-resolvedで拒否する", () => {
    const snapshot = stage1Snapshot();
    const first = transitionTeam(snapshot, replyCommand(), new Date(roundStartedAt));
    const replied = (first as { ok: true; snapshot: TeamSnapshot }).snapshot;
    const second = replyCommand({
      commandId: "00000000-0000-4000-8000-000000000003",
      expectedRevision: 1,
    });
    expect(transitionTeam(replied, second, new Date(roundStartedAt))).toEqual({
      ok: false,
      reason: "already-resolved",
    });
  });

  it("prologue状態への返信提出をforbidden-transitionで拒否する", () => {
    const prologue = initialTeamSnapshot("000003");
    expect(transitionTeam(prologue, replyCommand(), new Date(roundStartedAt))).toEqual({
      ok: false,
      reason: "forbidden-transition",
    });
  });

  it("expectedRevisionの不一致をrevision-conflictで拒否する", () => {
    const snapshot = stage1Snapshot();
    const command = replyCommand({ expectedRevision: 1 });
    expect(transitionTeam(snapshot, command, new Date(roundStartedAt))).toEqual({
      ok: false,
      reason: "revision-conflict",
    });
  });
});
