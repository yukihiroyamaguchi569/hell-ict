import { describe, expect, it } from "vitest";

import {
  commandResultSchema,
  leaderboardSnapshotSchema,
  leaderboardSocketAttachmentSchema,
  teamSnapshotSchema,
  teamSocketAttachmentSchema,
  teamStateSchema,
} from "../src/schemas/team-state.js";

const validMetrics = { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 };
const validState = { mode: "peace", stage: "prologue", metrics: validMetrics };
const stage1State = {
  mode: "peace",
  stage: "stage1",
  metrics: validMetrics,
  stage1: { roundStartedAt: "2026-08-21T00:00:00.000Z", replies: [] },
};
const validSnapshot = { teamCode: "000000", revision: 0, state: validState };

describe("チーム状態schemaの境界", () => {
  it("正当なstateを受理し、両stageを許可する", () => {
    expect(teamStateSchema.parse(validState)).toEqual(validState);
    expect(teamStateSchema.parse(stage1State)).toEqual(stage1State);
  });

  it("modeとstageのリテラル違い、metricsの値違い、未知キーを拒否する", () => {
    for (const input of [
      { ...validState, mode: "" },
      { ...validState, mode: "war" },
      { ...validState, stage: "" },
      { ...validState, stage: "stage2" },
      { ...validState, extra: true },
      { ...validState, metrics: { ...validMetrics, extra: 1 } },
      { ...validState, metrics: { ...validMetrics, occupancy: 399 } },
    ]) {
      expect(teamStateSchema.safeParse(input).success).toBe(false);
    }
  });

  it("stage固有のフィールドの過不足を拒否する", () => {
    // prologueなのにstage1フィールドを持つ、stage1なのにstage1フィールドが無い、を両方拒否する。
    expect(teamStateSchema.safeParse({ ...validState, stage1: stage1State.stage1 }).success).toBe(
      false,
    );
    expect(
      teamStateSchema.safeParse({ mode: "peace", stage: "stage1", metrics: validMetrics }).success,
    ).toBe(false);
    expect(
      teamStateSchema.safeParse({
        ...stage1State,
        stage1: { roundStartedAt: "not-a-datetime", replies: [] },
      }).success,
    ).toBe(false);
    expect(
      teamStateSchema.safeParse({
        ...stage1State,
        stage1: { roundStartedAt: stage1State.stage1.roundStartedAt, replies: [{ emailId: "m1" }] },
      }).success,
    ).toBe(false);
  });

  it("snapshotとcommand resultの構造を受理し、欠落と負のrevisionを拒否する", () => {
    expect(teamSnapshotSchema.parse(validSnapshot)).toEqual(validSnapshot);
    const result = { snapshot: validSnapshot, applied: true, leaderboardPending: false };
    expect(commandResultSchema.parse(result)).toEqual(result);
    expect(teamSnapshotSchema.safeParse({ ...validSnapshot, revision: -1 }).success).toBe(false);
    expect(teamSnapshotSchema.safeParse({ teamCode: "000000", revision: 0 }).success).toBe(false);
    expect(commandResultSchema.safeParse({ snapshot: validSnapshot, applied: true }).success).toBe(
      false,
    );
  });

  it("リーダーボード配信は空でないmarkerと既知stageの一覧だけを受理する", () => {
    const snapshot = {
      revision: 2,
      entries: [
        { marker: "チーム1", isSelf: true, stage: "stage1", teamRevision: 1 },
        { marker: "チーム10", isSelf: false, stage: "prologue", teamRevision: 0 },
      ],
    };
    expect(leaderboardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const entry of [
      { marker: "", isSelf: true, stage: "prologue", teamRevision: 0 },
      { marker: "チーム1", isSelf: true, stage: "", teamRevision: 0 },
      { marker: "チーム1", isSelf: true, stage: "prologue", teamRevision: 0, teamCode: "000000" },
    ]) {
      expect(leaderboardSnapshotSchema.safeParse({ revision: 0, entries: [entry] }).success).toBe(
        false,
      );
    }
  });

  it("socket attachmentはkindリテラルが一致する構造だけを受理する", () => {
    const team = { kind: "team", teamCode: "000000" };
    const leaderboard = { kind: "leaderboard", teamCode: "000000" };
    expect(teamSocketAttachmentSchema.parse(team)).toEqual(team);
    expect(leaderboardSocketAttachmentSchema.parse(leaderboard)).toEqual(leaderboard);
    for (const input of [
      { kind: "", teamCode: "000000" },
      { kind: "leaderboard", teamCode: "000000", extra: true },
      { kind: "team" },
    ]) {
      expect(teamSocketAttachmentSchema.safeParse(input).success).toBe(false);
      expect(leaderboardSocketAttachmentSchema.safeParse(input).success).toBe(false);
    }
  });
});
