import { checkpointSnapshotSchema } from "@hell-ict/domain";
import type { CheckpointSnapshot } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { replayCheckpoint } from "../src/checkpoint-store.js";

const fingerprint = "a".repeat(64);
const otherFingerprint = "b".repeat(64);

const snapshot = (revision: number): CheckpointSnapshot =>
  checkpointSnapshotSchema.parse({
    teamCode: "000000",
    revision,
    savedAt: "2026-09-03T00:00:00.000Z",
    body: {
      view: "s3",
      pos: 2,
      elapsedMs: 1000,
      trap: { s3Used: false, s5Used: false },
      data: { answer: "A" },
    },
  });

describe("replayCheckpoint（台帳にあるcommandIdの再送）", () => {
  it("台帳のrevisionが現在のrevisionと同じなら、現在のsnapshotをそのまま返す", () => {
    const current = snapshot(3);
    expect(replayCheckpoint(current, { revision: 3, fingerprint }, fingerprint)).toBe(current);
  });

  it("台帳のrevisionが現在より古ければ、上書き済みの保存としてconflictにする", () => {
    expect(replayCheckpoint(snapshot(4), { revision: 3, fingerprint }, fingerprint)).toEqual({
      rejected: "conflict",
    });
  });

  it("台帳のrevisionが現在より新しくてもconflictにする（一致以外は再送とみなさない）", () => {
    expect(replayCheckpoint(snapshot(2), { revision: 3, fingerprint }, fingerprint)).toEqual({
      rejected: "conflict",
    });
  });

  it("現在のsnapshotが無ければconflictにする（リセット後などに台帳だけ残った場合）", () => {
    expect(replayCheckpoint(null, { revision: 1, fingerprint }, fingerprint)).toEqual({
      rejected: "conflict",
    });
  });

  it("同じcommandIdで指紋が違えば、revisionが一致していてもconflictにする", () => {
    expect(
      replayCheckpoint(snapshot(3), { revision: 3, fingerprint: otherFingerprint }, fingerprint),
    ).toEqual({ rejected: "conflict" });
  });

  it("指紋を持たない古い台帳行は照合を飛ばし、revisionだけで判定する", () => {
    const current = snapshot(3);
    expect(replayCheckpoint(current, { revision: 3, fingerprint: null }, fingerprint)).toBe(
      current,
    );
    expect(replayCheckpoint(current, { revision: 2, fingerprint: null }, fingerprint)).toEqual({
      rejected: "conflict",
    });
  });
});
