import { describe, expect, it } from "vitest";

import { applyCheckpoint, mergeCheckpoint } from "../src/checkpoint.js";
import {
  CHECKPOINT_DATA_MAX_BYTES,
  CHECKPOINT_DATA_MAX_DEPTH,
  CHECKPOINT_ELAPSED_MAX_MS,
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

/** data直下を深さ1として、深さ`depth`の葉を1つ持つ入れ子を作る。 */
const nested = (depth: number): Record<string, unknown> => {
  let node: unknown = "x";
  for (let level = 1; level < depth; level += 1) node = { a: node };
  return { a: node };
};

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

  it("elapsedMsは上限ちょうどまで受け入れる", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      elapsedMs: CHECKPOINT_ELAPSED_MAX_MS,
    });
    expect(parsed.success).toBe(true);
  });

  it("elapsedMsが上限を1ms超えたら拒否する", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      elapsedMs: CHECKPOINT_ELAPSED_MAX_MS + 1,
    });
    expect(parsed.success).toBe(false);
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

  it("dataの入れ子は上限の深さちょうどまで受け入れる", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      data: nested(CHECKPOINT_DATA_MAX_DEPTH),
    });
    expect(parsed.success).toBe(true);
  });

  it("dataの入れ子が上限を1段超えたら拒否する", () => {
    const parsed = checkpointBodySchema.safeParse({
      ...body(),
      data: nested(CHECKPOINT_DATA_MAX_DEPTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("深さ5000の配列でも例外にならず拒否する", () => {
    // 再帰schemaへ渡すとRangeErrorになる深さ。反復の深さ検査で先に落とす。
    let deep: unknown = [];
    for (let level = 0; level < 5000; level += 1) deep = [deep];
    expect(() => checkpointBodySchema.safeParse({ ...body(), data: { deep } })).not.toThrow();
    expect(checkpointBodySchema.safeParse({ ...body(), data: { deep } }).success).toBe(false);
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

describe("mergeCheckpoint（離脱時flushの単調合成）", () => {
  const current = body({
    view: "stage3-manual",
    pos: 3,
    elapsedMs: 5000,
    trap: { s3Used: true, s4Used: false },
    data: { from: "current" },
  });

  it("trapはOR、posとelapsedMsはmaxで合成する", () => {
    const incoming = body({
      view: "stage4",
      pos: 2,
      elapsedMs: 1000,
      trap: { s3Used: false, s4Used: true },
      data: { from: "incoming" },
    });
    const merged = mergeCheckpoint(current, incoming);
    expect(merged.trap).toEqual({ s3Used: true, s4Used: true });
    expect(merged.pos).toBe(3);
    expect(merged.elapsedMs).toBe(5000);
  });

  it("viewとdataはposが大きい側を採る", () => {
    const ahead = body({ view: "stage4", pos: 5, data: { from: "incoming" } });
    expect(mergeCheckpoint(current, ahead)).toMatchObject({
      view: "stage4",
      pos: 5,
      data: { from: "incoming" },
    });

    const behind = body({ view: "stage2", pos: 1, data: { from: "incoming" } });
    expect(mergeCheckpoint(current, behind)).toMatchObject({
      view: "stage3-manual",
      pos: 3,
      data: { from: "current" },
    });
  });

  it("posが同値なら受信側を新しいとみなす", () => {
    const same = body({ view: "stage3-notice", pos: 3, data: { from: "incoming" } });
    expect(mergeCheckpoint(current, same)).toMatchObject({
      view: "stage3-notice",
      data: { from: "incoming" },
    });
  });
});

describe("applyCheckpointのflush", () => {
  const saved = snapshot(7, {
    view: "stage3-manual",
    pos: 3,
    elapsedMs: 5000,
    trap: { s3Used: true, s4Used: false },
  });

  const flushCommand = (expectedRevision: number, bodyOverrides: Partial<CheckpointBody> = {}) =>
    saveCheckpointCommandSchema.parse({
      type: "save-checkpoint",
      commandId,
      expectedRevision,
      body: body(bodyOverrides),
      flush: true,
    });

  it("古いrevisionのflushでも確定し、trapは落ちない", () => {
    // keepaliveは応答を待てないので、CASで弾くと罠フラグが黙って消える。
    const result = applyCheckpoint(
      saved,
      flushCommand(2, { trap: { s3Used: false, s4Used: true } }),
      {
        teamCode: "000000",
        now,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.revision).toBe(8);
    expect(result.snapshot.body.trap).toEqual({ s3Used: true, s4Used: true });
  });

  it("flushはposとelapsedMsを後退させない", () => {
    const result = applyCheckpoint(saved, flushCommand(2, { pos: 1, elapsedMs: 10 }), {
      teamCode: "000000",
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot.body).toMatchObject({ pos: 3, elapsedMs: 5000 });
  });

  it("未保存へのflushは受信bodyをそのまま採る", () => {
    const result = applyCheckpoint(null, flushCommand(0, { pos: 4 }), { teamCode: "000000", now });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.snapshot).toMatchObject({ revision: 1, body: { pos: 4 } });
  });

  it("flushが無ければ従来どおり古いrevisionはconflict", () => {
    expect(applyCheckpoint(saved, command(2), { teamCode: "000000", now })).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});

describe("dataRevisionによるdataの前後関係", () => {
  const current = body({
    view: "stage3-manual",
    pos: 3,
    dataRevision: 5,
    data: { s3Penalty: "in-progress" },
  });

  it("同じposなら、dataRevisionの小さい側はdataを巻き戻さない", () => {
    // 古いタブのflushが罰の進行状態をin-progressからnoneへ戻せてしまう経路を塞ぐ。
    const stale = body({ view: "s3", pos: 3, dataRevision: 2, data: { s3Penalty: "none" } });
    const merged = mergeCheckpoint(current, stale);
    expect(merged.data).toEqual({ s3Penalty: "in-progress" });
    expect(merged.view).toBe("stage3-manual");
    expect(merged.dataRevision).toBe(5);
  });

  it("同じposなら、dataRevisionの大きい側が採用される", () => {
    const fresh = body({ view: "s3", pos: 3, dataRevision: 9, data: { s3Penalty: "done" } });
    const merged = mergeCheckpoint(current, fresh);
    expect(merged.data).toEqual({ s3Penalty: "done" });
    expect(merged.view).toBe("s3");
    expect(merged.dataRevision).toBe(9);
  });

  it("同じposでdataRevisionも同じなら受信側を新しいとみなす", () => {
    const same = body({ view: "s3", pos: 3, dataRevision: 5, data: { s3Penalty: "done" } });
    expect(mergeCheckpoint(current, same)).toMatchObject({
      view: "s3",
      data: { s3Penalty: "done" },
    });
  });

  it("posが違えばdataRevisionによらずposの大きい側を採る", () => {
    const ahead = body({ view: "s4", pos: 5, dataRevision: 1, data: { from: "ahead" } });
    expect(mergeCheckpoint(current, ahead)).toMatchObject({
      pos: 5,
      view: "s4",
      data: { from: "ahead" },
    });
    // dataRevisionはmaxなので、進んだ側が小さくても後退しない。
    expect(mergeCheckpoint(current, ahead).dataRevision).toBe(5);
  });

  it("通常保存でdataRevisionの後退はdata-regressionで拒否する", () => {
    const saved = snapshot(1, { pos: 3, dataRevision: 5 });
    expect(
      applyCheckpoint(saved, command(1, { pos: 3, dataRevision: 4 }), { teamCode: "000000", now }),
    ).toEqual({ ok: false, reason: "data-regression" });
    // 同値は許可する（同じ画面の再保存）。
    expect(
      applyCheckpoint(saved, command(1, { pos: 3, dataRevision: 5 }), { teamCode: "000000", now })
        .ok,
    ).toBe(true);
  });
});

describe("dataRevisionの上限", () => {
  const withDataRevision = (dataRevision: number) =>
    checkpointBodySchema.safeParse({
      view: "s3",
      pos: 2,
      elapsedMs: 1000,
      trap: { s3Used: false, s4Used: false },
      data: {},
      dataRevision,
    });

  it("上限ちょうど（MAX_SAFE_INTEGER - 1）は通る", () => {
    expect(withDataRevision(Number.MAX_SAFE_INTEGER - 1).success).toBe(true);
  });

  it("MAX_SAFE_INTEGERは拒否する", () => {
    // ここまで来ると以後の+1が精度を失い、世代番号として単調でなくなる。
    expect(withDataRevision(Number.MAX_SAFE_INTEGER).success).toBe(false);
  });

  it("負数・小数も拒否する", () => {
    expect(withDataRevision(-1).success).toBe(false);
    expect(withDataRevision(1.5).success).toBe(false);
  });
});
