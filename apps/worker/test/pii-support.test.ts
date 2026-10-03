import { describe, expect, it } from "vitest";

import { PII_NAME, PII_SURNAME, SECOND_SURNAME, surnameOf } from "./pii-support.js";

describe("PII テストの氏名の派生", () => {
  it("姓は氏名の先頭で、氏名全体より短い（姓だけの検査が氏名全体の検査に化けない）", () => {
    expect(PII_NAME.startsWith(PII_SURNAME)).toBe(true);
    expect(PII_SURNAME.length).toBeLessThan(PII_NAME.length);
    expect(SECOND_SURNAME).not.toBe(PII_SURNAME);
  });

  it("姓と名を半角空白で区切っていない氏名は、派生を作らずに落とす", () => {
    expect(surnameOf("山田 太郎")).toBe("山田");
    for (const broken of ["山田太郎", "山田 ", " 太郎", ""]) {
      expect(() => surnameOf(broken), broken).toThrow("半角空白");
    }
  });
});
