import { describe, expect, it } from "vitest";

import { CHECKPOINT_IDS_VERSION, checkpointBodySchema } from "../src/schemas/checkpoint.js";
import {
  normalizeLegacyCheckpointBody,
  normalizeLegacyCheckpointCommand,
  normalizeLegacyCheckpointSnapshot,
  normalizeLegacyViewField,
  normalizeLegacyViewId,
} from "../src/legacy-ids.js";

/** 2026-09-06の振り直しより前に保存されたbody。版マーカー（idsVersion）を持たない。 */
const legacyBody = (view: string, data: Record<string, unknown> = {}) => ({
  view,
  pos: 5,
  elapsedMs: 60_000,
  trap: { s3Used: true, s4Used: true },
  dataRevision: 3,
  data,
});

/** 振り直し後のbody。版マーカーを持つ。 */
const currentBody = (view: string, data: Record<string, unknown> = {}) => ({
  view,
  idsVersion: CHECKPOINT_IDS_VERSION,
  pos: 5,
  elapsedMs: 60_000,
  trap: { s3Used: false, s5Used: false },
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

describe("normalizeLegacyViewField", () => {
  it("viewを持つオブジェクトの旧名だけを直し、他のキーは触らない", () => {
    expect(
      normalizeLegacyViewField({ teamCode: "123456", view: "s35", kind: "clear", pos: 4 }),
    ).toEqual({ teamCode: "123456", view: "s4", kind: "clear", pos: 4 });
  });

  it("判別できないs4・s5はそのまま通す", () => {
    expect(normalizeLegacyViewField({ view: "s4" })).toEqual({ view: "s4" });
    expect(normalizeLegacyViewField({ view: "s5" })).toEqual({ view: "s5" });
  });

  it.each([null, undefined, "s35", 42, [], { view: 7 }, {}])(
    "viewを持たない・形が想定外の入力は手を触れずに返す（%s）",
    (input) => {
      expect(normalizeLegacyViewField(input)).toEqual(input);
    },
  );
});

describe("normalizeLegacyCheckpointBody", () => {
  it.each([
    ["s35", "s4"],
    ["s4", "s5"],
    ["s5", "s6"],
  ])("版マーカーが無ければ旧体系として画面id %s を %s へずらす", (before, after) => {
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

  it("読み替えたbodyには版マーカーが立つ", () => {
    const normalized = checkpointBodySchema.parse(normalizeLegacyCheckpointBody(legacyBody("s4")));
    expect(normalized.idsVersion).toBe(CHECKPOINT_IDS_VERSION);
  });

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

  it("dataが空でも落ちず、画面idと罠だけを直す", () => {
    const normalized = checkpointBodySchema.parse(normalizeLegacyCheckpointBody(legacyBody("s5")));
    expect(normalized).toMatchObject({
      view: "s6",
      trap: { s3Used: true, s5Used: true },
      data: {},
    });
  });

  it("旧bodyがtrapを持たなくても、画面idは対応表どおりずらす", () => {
    // 判別を罠フラグのキーに頼っていると、ここで旧名のまま素通りしてschemaに弾かれ、
    // そのチームが復帰できなくなる。版マーカーの有無で決めているので落ちない。
    const withoutTrap = { ...legacyBody("s5"), trap: undefined };
    delete withoutTrap.trap;
    expect(normalizeLegacyCheckpointBody(withoutTrap)).toMatchObject({
      view: "s6",
      idsVersion: CHECKPOINT_IDS_VERSION,
    });
  });

  it("旧bodyがdataを持たなくても落ちない", () => {
    const withoutData = { ...legacyBody("s4"), data: undefined };
    delete withoutData.data;
    expect(normalizeLegacyCheckpointBody(withoutData)).toMatchObject({
      view: "s5",
      trap: { s3Used: true, s5Used: true },
    });
  });

  it.each([
    ["s4", "s4"],
    ["s5", "s5"],
    ["s6", "s6"],
  ])("版マーカー付きの%sは読み替えず、そのまま同じオブジェクトを返す", (view) => {
    const body = currentBody(view, { s5Penalty: "none", s4Summary: "none" });
    expect(normalizeLegacyCheckpointBody(body)).toBe(body);
  });

  it("マーカー付きbodyへの再適用は何も変えない", () => {
    const once = normalizeLegacyCheckpointBody(legacyBody("s35"));
    expect(normalizeLegacyCheckpointBody(once)).toBe(once);
  });

  it("マーカーを入れる前に新名で保存されたbodyは、罠フラグの形で新体系と見なす", () => {
    // trapが新名だけを持つ＝振り直し後に書かれたbody。マーカーだけ足して中身は触らない。
    const body = {
      view: "s4",
      pos: 4,
      elapsedMs: 0,
      trap: { s3Used: false, s5Used: false },
      dataRevision: 0,
      data: {},
    };
    expect(normalizeLegacyCheckpointBody(body)).toEqual({
      ...body,
      idsVersion: CHECKPOINT_IDS_VERSION,
    });
  });

  it.each([null, undefined, 42, "s4", [], { trap: null }, { trap: [] }, { view: "s4" }])(
    "bodyの形が想定外なら画面idの読み替えだけを試みて落ちない（%s）",
    (input) => {
      expect(() => normalizeLegacyCheckpointBody(input)).not.toThrow();
    },
  );

  it.each([null, undefined, 42, "s4", []])("recordでない入力はそのまま返す（%s）", (input) => {
    expect(normalizeLegacyCheckpointBody(input)).toEqual(input);
  });

  it("dataがオブジェクトでなくても落ちない", () => {
    const normalized = normalizeLegacyCheckpointBody({ ...legacyBody("s5"), data: "壊れた値" });
    expect(normalized).toMatchObject({ view: "s6", data: "壊れた値" });
    expect(checkpointBodySchema.safeParse(normalized).success).toBe(false);
  });
});

describe("normalizeLegacyCheckpointSnapshot / Command", () => {
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

  it("保存コマンドのbodyも同じ規則で読み替える（旧タブからのPOST）", () => {
    const command = {
      type: "save-checkpoint",
      commandId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: 1,
      generation: 0,
      body: legacyBody("s35", { s35Summary: "submitted" }),
    };
    expect(normalizeLegacyCheckpointCommand(command)).toMatchObject({
      type: "save-checkpoint",
      expectedRevision: 1,
      body: {
        view: "s4",
        idsVersion: CHECKPOINT_IDS_VERSION,
        trap: { s3Used: true, s5Used: true },
        data: { s4Summary: "submitted" },
      },
    });
  });

  it.each([null, "壊れた値", 0])("形が想定外なら手を触れずに返す（%s）", (input) => {
    expect(normalizeLegacyCheckpointSnapshot(input)).toEqual(input);
    expect(normalizeLegacyCheckpointCommand(input)).toEqual(input);
  });
});
