import { describe, expect, it } from "vitest";

import { checkpointBodySchema } from "../src/schemas/checkpoint.js";
import {
  normalizeLegacyCheckpointBody,
  normalizeLegacyCheckpointSnapshot,
  normalizeLegacyViewId,
} from "../src/legacy-ids.js";

/** 2026-09-06 の振り直しより前に保存されたbody。罠フラグが`s4Used`である点で見分ける。 */
const legacyBody = (view: string, data: Record<string, unknown> = {}) => ({
  view,
  pos: 5,
  elapsedMs: 60_000,
  trap: { s3Used: true, s4Used: true },
  dataRevision: 3,
  data,
});

describe("normalizeLegacyViewId", () => {
  it("新体系に存在しないs35だけを新名へ読み替える", () => {
    expect(normalizeLegacyViewId("s35")).toBe("s4");
  });

  it.each(["entry", "welcome", "inbox", "s1", "s2", "unlock", "s3", "s4", "s5", "s6", "final"])(
    "新名の%sは素通りさせる",
    (view) => {
      expect(normalizeLegacyViewId(view)).toBe(view);
    },
  );

  it("s4・s5は新旧どちらの体系にもあるので、値だけではずらさない", () => {
    // 一律にずらすと、振り直し後に書かれた行まで1つ後ろへ動いてしまう。
    expect(normalizeLegacyViewId("s4")).toBe("s4");
    expect(normalizeLegacyViewId("s5")).toBe("s5");
  });

  it("画面idでない文字列も落とさずそのまま返す（判定は呼び出し側のschemaに任せる）", () => {
    expect(normalizeLegacyViewId("")).toBe("");
    expect(normalizeLegacyViewId("s99")).toBe("s99");
  });
});

describe("normalizeLegacyCheckpointBody", () => {
  it.each([
    ["s35", "s4"],
    ["s4", "s5"],
    ["s5", "s6"],
  ])("旧bodyだと確定していれば画面id %s を %s へずらす", (before, after) => {
    const normalized = normalizeLegacyCheckpointBody(legacyBody(before));
    expect(checkpointBodySchema.parse(normalized).view).toBe(after);
  });

  it.each(["entry", "welcome", "inbox", "s1", "s2", "unlock", "s3", "final"])(
    "振り直しの対象外である%sは旧bodyでも動かさない",
    (view) => {
      const normalized = normalizeLegacyCheckpointBody(legacyBody(view));
      expect(checkpointBodySchema.parse(normalized).view).toBe(view);
    },
  );

  it("罠フラグのキーを新名へ移し、値と他のキーは保つ", () => {
    const normalized = checkpointBodySchema.parse(normalizeLegacyCheckpointBody(legacyBody("s4")));
    expect(normalized.trap).toEqual({ s3Used: true, s5Used: true });
    expect(normalized.pos).toBe(5);
    expect(normalized.elapsedMs).toBe(60_000);
    expect(normalized.dataRevision).toBe(3);
  });

  it("dataのステージ名キーも新名へ移す（値は不透明なまま）", () => {
    const normalized = normalizeLegacyCheckpointBody(
      legacyBody("s4", { s3Penalty: "done", s4Penalty: "in-progress", s35Summary: "done" }),
    );
    expect(checkpointBodySchema.parse(normalized).data).toEqual({
      s3Penalty: "done",
      s5Penalty: "in-progress",
      s4Summary: "done",
    });
  });

  it("旧キーを残さない（strictなschemaが弾く形にしない）", () => {
    const normalized = normalizeLegacyCheckpointBody(legacyBody("s4", { s4Penalty: "done" }));
    expect(checkpointBodySchema.safeParse(normalized).success).toBe(true);
  });

  it("新名で保存されたbodyは読み替えない", () => {
    const current = {
      view: "s4",
      pos: 5,
      elapsedMs: 0,
      trap: { s3Used: false, s5Used: false },
      dataRevision: 0,
      data: { s5Penalty: "none", s4Summary: "none" },
    };
    expect(normalizeLegacyCheckpointBody(current)).toEqual(current);
  });

  it.each([null, undefined, 42, "s4", [], { trap: null }, { trap: [] }, { view: "s4" }])(
    "bodyの形が想定外なら手を触れずに返す（%s）",
    (input) => {
      expect(normalizeLegacyCheckpointBody(input)).toEqual(input);
    },
  );

  it("dataがオブジェクトでなくても落ちない", () => {
    const normalized = normalizeLegacyCheckpointBody({ ...legacyBody("s5"), data: "壊れた値" });
    expect(normalized).toMatchObject({ view: "s6", data: "壊れた値" });
    expect(checkpointBodySchema.safeParse(normalized).success).toBe(false);
  });
});

describe("normalizeLegacyCheckpointSnapshot", () => {
  it("snapshotのbodyだけを読み替え、外側はそのまま返す", () => {
    const snapshot = {
      teamCode: "123456",
      revision: 7,
      savedAt: "2026-08-23T01:00:00.000Z",
      body: legacyBody("s5"),
    };
    expect(normalizeLegacyCheckpointSnapshot(snapshot)).toMatchObject({
      teamCode: "123456",
      revision: 7,
      savedAt: "2026-08-23T01:00:00.000Z",
      body: { view: "s6", trap: { s3Used: true, s5Used: true } },
    });
  });

  it.each([null, "壊れた値", 0])("snapshotの形が想定外なら手を触れずに返す（%s）", (input) => {
    expect(normalizeLegacyCheckpointSnapshot(input)).toEqual(input);
  });
});
