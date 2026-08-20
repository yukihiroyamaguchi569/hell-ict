import { describe, expect, it } from "vitest";

import { teamCodeSchema, teamCommandSchema } from "../src/schemas/team-state.js";
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
    const transitioned = transitionTeam(initial, command);
    expect(transitioned).toEqual({
      ok: true,
      snapshot: { ...initial, revision: 1, state: { ...initial.state, stage: "stage1" } },
    });
    expect(transitionTeam(initial, { ...command, expectedRevision: -1 })).toEqual({
      ok: false,
      reason: "revision-conflict",
    });
    const stage1 = (transitioned as { ok: true; snapshot: typeof initial }).snapshot;
    expect(transitionTeam(stage1, command)).toEqual({ ok: false, reason: "revision-conflict" });
    expect(transitionTeam(stage1, { ...command, expectedRevision: 1 })).toEqual({
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
