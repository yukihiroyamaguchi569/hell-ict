import { describe, expect, it } from "vitest";

import {
  checkpointFingerprint,
  createThreadFingerprint,
  stableStringify,
} from "../src/fingerprint.js";

describe("stableStringify", () => {
  it("キーの並び順に依存しない", () => {
    // JSON.stringifyは挿入順をそのまま出すので、同じ内容でもキー順が違うだけで
    // 別の指紋になり、正当な再送を取り違えとして弾いてしまう。
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ outer: { y: 1, x: 2 } })).toBe(
      stableStringify({ outer: { x: 2, y: 1 } }),
    );
  });

  it("配列の順序は保つ（順序が意味を持つため）", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("値が違えば違う文字列になる", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ b: 1 }));
    expect(stableStringify({ a: "1" })).not.toBe(stableStringify({ a: 1 }));
  });

  it('JSONへ落とせない値は"null"へ畳んで安定させる', () => {
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify(null)).toBe("null");
    // undefinedのプロパティは省く（JSON.stringifyと同じ扱い）。
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe("createThreadFingerprint", () => {
  it("同じtitle・kindなら同じ指紋", async () => {
    const first = await createThreadFingerprint({ title: "副", kind: "manual" });
    expect(await createThreadFingerprint({ title: "副", kind: "manual" })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("titleかkindが変われば指紋も変わる", async () => {
    const base = await createThreadFingerprint({ title: "副", kind: "manual" });
    expect(await createThreadFingerprint({ title: "別", kind: "manual" })).not.toBe(base);
    expect(await createThreadFingerprint({ title: "副", kind: "stage" })).not.toBe(base);
  });

  it("フィールドの境界が潰れない", async () => {
    const left = await createThreadFingerprint({ title: "ab", kind: "c" });
    const right = await createThreadFingerprint({ title: "a", kind: "bc" });
    expect(left).not.toBe(right);
  });
});

describe("checkpointFingerprint", () => {
  const body = { view: "s3", pos: 3, data: { s3Penalty: "in-progress" } };

  it("キー順が違っても同じ指紋", async () => {
    const first = await checkpointFingerprint(body);
    const reordered = { data: { s3Penalty: "in-progress" }, pos: 3, view: "s3" };
    expect(await checkpointFingerprint(reordered)).toBe(first);
  });

  it("中身が変われば指紋も変わる", async () => {
    const first = await checkpointFingerprint(body);
    expect(await checkpointFingerprint({ ...body, pos: 4 })).not.toBe(first);
    expect(await checkpointFingerprint({ ...body, data: { s3Penalty: "none" } })).not.toBe(first);
  });
});
