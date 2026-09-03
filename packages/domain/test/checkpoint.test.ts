import { describe, expect, it } from "vitest";

import { applyCheckpoint } from "../src/checkpoint.js";
import {
  CHECKPOINT_DATA_MAX_BYTES,
  CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
  checkpointBodySchema,
  checkpointSnapshotSchema,
  saveCheckpointCommandSchema,
} from "../src/schemas/checkpoint.js";
import type { CheckpointBody, CheckpointSnapshot } from "../src/schemas/checkpoint.js";

const commandId = "00000000-0000-4000-8000-000000000001";
const now = "2026-09-03T00:00:00.000Z";

const body = (overrides: Partial<CheckpointBody> = {}): CheckpointBody =>
  checkpointBodySchema.parse({
    view: "stage3-manual",
    pos: 2,
    elapsedMs: 1000,
    trap: { s3Used: false, s4Used: false },
    data: { answer: "A" },
    ...overrides,
  });

const command = (expectedRevision: number, bodyOverrides: Partial<CheckpointBody> = {}) =>
  saveCheckpointCommandSchema.parse({
    type: "save-checkpoint",
    commandId,
    expectedRevision,
    body: body(bodyOverrides),
  });

const snapshot = (revision: number, bodyOverrides: Partial<CheckpointBody> = {}) =>
  checkpointSnapshotSchema.parse({
    teamCode: "000000",
    revision,
    savedAt: "2026-09-03T00:00:00.000Z",
    body: body(bodyOverrides),
  });

/** `data`のJSON化バイト数がちょうど`bytes`になるレコードを作る。 */
const dataOfBytes = (bytes: number): Record<string, unknown> => {
  const envelope = JSON.stringify({ a: "" }).length;
  return { a: "x".repeat(bytes - envelope) };
};

describe("チェックポイントの純粋関数", () => {
  it("未保存からの初回保存はrevision 1を作る", () => {
    const result = applyCheckpoint(null, command(0), { teamCode: "000000", now });
    expect(result).toEqual({
      ok: true,
      snapshot: { teamCode: "000000", revision: 1, savedAt: now, body: body() },
    });
  });

  it("未保存に対してexpectedRevisionが0以外なら競合とする", () => {
    const result = applyCheckpoint(null, command(1), { teamCode: "000000", now });
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it("既存revisionと一致すればrevisionを1進める", () => {
    const result = applyCheckpoint(snapshot(3), command(3), { teamCode: "000000", now });
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.revision).toBe(4);
    expect(result.snapshot.savedAt).toBe(now);
  });

  it.each([
    { label: "古い", expectedRevision: 2 },
    { label: "先の", expectedRevision: 4 },
  ])("$labelrevisionを送ると競合とする", ({ expectedRevision }) => {
    const result = applyCheckpoint(snapshot(3), command(expectedRevision), {
      teamCode: "000000",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it.each([
    {
      label: "s3",
      current: { s3Used: true, s4Used: false },
      next: { s3Used: false, s4Used: false },
    },
    {
      label: "s4",
      current: { s3Used: false, s4Used: true },
      next: { s3Used: false, s4Used: false },
    },
    {
      label: "両方",
      current: { s3Used: true, s4Used: true },
      next: { s3Used: false, s4Used: false },
    },
  ])("$labelの罠フラグをfalseへ戻す保存を拒否する", ({ current, next }) => {
    const result = applyCheckpoint(snapshot(1, { trap: current }), command(1, { trap: next }), {
      teamCode: "000000",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "trap-regression" });
  });

  it("罠フラグをfalseからtrueへ進める保存は許可する", () => {
    const result = applyCheckpoint(
      snapshot(1, { trap: { s3Used: false, s4Used: false } }),
      command(1, { trap: { s3Used: true, s4Used: true } }),
      { teamCode: "000000", now },
    );
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.body.trap).toEqual({ s3Used: true, s4Used: true });
  });

  it("発動済みの罠を保ったままの保存は許可する", () => {
    const trap = { s3Used: true, s4Used: false };
    const result = applyCheckpoint(snapshot(1, { trap }), command(1, { trap }), {
      teamCode: "000000",
      now,
    });
    expect(result.ok).toBe(true);
  });

  it("elapsedMsを巻き戻す保存を拒否する", () => {
    const result = applyCheckpoint(
      snapshot(1, { elapsedMs: 60_000 }),
      command(1, { elapsedMs: 59_999 }),
      { teamCode: "000000", now },
    );
    expect(result).toEqual({ ok: false, reason: "elapsed-regression" });
  });

  it.each([
    { label: "同値", elapsedMs: 60_000 },
    { label: "前進", elapsedMs: 60_001 },
  ])("elapsedMsが$labelなら許可する", ({ elapsedMs }) => {
    const result = applyCheckpoint(snapshot(1, { elapsedMs: 60_000 }), command(1, { elapsedMs }), {
      teamCode: "000000",
      now,
    });
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.body.elapsedMs).toBe(elapsedMs);
  });

  it("未保存への初回保存はelapsedMsを比較しない", () => {
    const result = applyCheckpoint(null, command(0, { elapsedMs: 0 }), {
      teamCode: "000000",
      now,
    });
    expect(result.ok).toBe(true);
  });

  it("競合とelapsedMs後退が同時に成立する場合は競合を優先する", () => {
    const result = applyCheckpoint(
      snapshot(1, { elapsedMs: 60_000 }),
      command(0, { elapsedMs: 0 }),
      { teamCode: "000000", now },
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it("罠後退とelapsedMs後退が同時に成立する場合は罠を優先する", () => {
    const result = applyCheckpoint(
      snapshot(1, { trap: { s3Used: true, s4Used: false }, elapsedMs: 60_000 }),
      command(1, { trap: { s3Used: false, s4Used: false }, elapsedMs: 0 }),
      { teamCode: "000000", now },
    );
    expect(result).toEqual({ ok: false, reason: "trap-regression" });
  });

  it("posを巻き戻す保存を拒否する", () => {
    const result = applyCheckpoint(snapshot(1, { pos: 4 }), command(1, { pos: 3 }), {
      teamCode: "000000",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "pos-regression" });
  });

  it.each([
    { label: "同値", pos: 4 },
    { label: "前進", pos: 5 },
  ])("posが$labelなら許可する", ({ pos }) => {
    const result = applyCheckpoint(snapshot(1, { pos: 4 }), command(1, { pos }), {
      teamCode: "000000",
      now,
    });
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.body.pos).toBe(pos);
  });

  it("未保存への初回保存はposを比較しない", () => {
    const result = applyCheckpoint(null, command(0, { pos: 0 }), { teamCode: "000000", now });
    expect(result.ok).toBe(true);
  });

  it("同じposのままviewだけ戻る保存は許可する", () => {
    const result = applyCheckpoint(
      snapshot(1, { pos: 4, view: "stage3-quiz" }),
      command(1, { pos: 4, view: "stage3-manual" }),
      { teamCode: "000000", now },
    );
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.body.view).toBe("stage3-manual");
  });

  it("elapsedMs後退とpos後退が同時に成立する場合はelapsedMsを優先する", () => {
    const result = applyCheckpoint(
      snapshot(1, { pos: 4, elapsedMs: 60_000 }),
      command(1, { pos: 3, elapsedMs: 0 }),
      { teamCode: "000000", now },
    );
    expect(result).toEqual({ ok: false, reason: "elapsed-regression" });
  });

  it("競合と罠後退が同時に成立する場合は競合を優先する", () => {
    const result = applyCheckpoint(
      snapshot(1, { trap: { s3Used: true, s4Used: false } }),
      command(0, { trap: { s3Used: false, s4Used: false } }),
      { teamCode: "000000", now },
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it("入力のsnapshotを書き換えない", () => {
    const current: CheckpointSnapshot = snapshot(1);
    applyCheckpoint(current, command(1, { pos: 7 }), { teamCode: "000000", now });
    expect(current).toEqual(snapshot(1));
  });
});

describe("チェックポイントのschema", () => {
  it.each(["Stage3", "stage_3", "ステージ", "", "a".repeat(33)])(
    "viewの不正値 %s を拒否する",
    (view) => {
      expect(checkpointBodySchema.safeParse({ ...body(), view }).success).toBe(false);
    },
  );

  it.each([-1, 8, 1.5])("posの範囲外 %s を拒否する", (pos) => {
    expect(checkpointBodySchema.safeParse({ ...body(), pos }).success).toBe(false);
  });

  it.each([-1, 1.5])("elapsedMsの不正値 %s を拒否する", (elapsedMs) => {
    expect(checkpointBodySchema.safeParse({ ...body(), elapsedMs }).success).toBe(false);
  });

  it("trapに余分なキーがあれば拒否する", () => {
    const trap = { s3Used: false, s4Used: false, s5Used: false };
    expect(checkpointBodySchema.safeParse({ ...body(), trap }).success).toBe(false);
  });

  it("bodyに未知のキーがあれば拒否する", () => {
    expect(checkpointBodySchema.safeParse({ ...body(), extra: 1 }).success).toBe(false);
  });

  it.each([
    { label: "Infinity", value: JSON.parse('{"a":1e400}') as unknown },
    { label: "NaN", value: { a: Number.NaN } },
    { label: "undefined", value: { a: undefined } },
    { label: "関数", value: { a: () => 1 } },
    { label: "入れ子のInfinity", value: JSON.parse('{"a":{"b":[1e400]}}') as unknown },
  ])("JSONにならない値 $label をdataに含む保存を拒否する", ({ value }) => {
    expect(checkpointBodySchema.safeParse({ ...body(), data: value }).success).toBe(false);
  });

  it("入れ子のオブジェクトと配列はそのまま往復する", () => {
    const data = { quiz: { answers: ["A", "B"], done: true }, notes: [1, null, { memo: "x" }] };
    const parsed = checkpointBodySchema.parse({ ...body(), data });
    expect(parsed.data).toEqual(data);
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(data);
  });

  it("dataは上限ちょうどまで受け入れる", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      data: dataOfBytes(CHECKPOINT_DATA_MAX_BYTES),
    });
    expect(parsed.success).toBe(true);
  });

  it("dataが上限を1バイト超えたら専用のメッセージで拒否する", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      data: dataOfBytes(CHECKPOINT_DATA_MAX_BYTES + 1),
    });
    if (parsed.success) throw new Error("unexpected");
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
    );
  });

  it("マルチバイト文字はバイト数で数える", () => {
    // "あ"は3バイト。文字数で数えていれば通ってしまう長さを弾く。
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      data: { a: "あ".repeat(CHECKPOINT_DATA_MAX_BYTES / 2) },
    });
    expect(parsed.success).toBe(false);
  });

  it("commandIdがUUIDでなければ拒否する", () => {
    const parsed = saveCheckpointCommandSchema.safeParse({
      type: "save-checkpoint",
      commandId: "not-a-uuid",
      expectedRevision: 0,
      body: body(),
    });
    expect(parsed.success).toBe(false);
  });

  it("typeが違うコマンドを拒否する", () => {
    const parsed = saveCheckpointCommandSchema.safeParse({
      type: "enter-stage1",
      commandId,
      expectedRevision: 0,
      body: body(),
    });
    expect(parsed.success).toBe(false);
  });
});
