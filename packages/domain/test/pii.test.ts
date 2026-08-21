import { describe, expect, it } from "vitest";

import { detectPii, stage4Patient } from "../src/pii.js";

describe("送信前PIIゲート", () => {
  it.each([
    ["患者氏名", `${stage4Patient.name}さんについて教えてください`],
    ["患者ID", `患者ID ${stage4Patient.id} の件です`],
    ["生年月日", `${stage4Patient.dob}生まれの方です`],
    ["電話番号", `連絡先は${stage4Patient.phone}です`],
    ["ご家族の氏名", `ご長男の${stage4Patient.familyName}様より`],
  ])("%sを検知する", (label, text) => {
    expect(detectPii(text)).toBe(label);
  });

  it.each(["渡辺　三郎", "渡辺三郎", "渡辺  三郎"])("氏名の表記ゆれ「%s」も検知する", (variant) => {
    expect(detectPii(`${variant}さんの件です`)).toBe("患者氏名");
  });

  it("正しく匿名化した依頼は誤爆しない", () => {
    expect(detectPii("5A病棟の70代男性のご家族へ、面会制限の説明文を作成してください")).toBeNull();
    expect(detectPii("原因不明の発熱について、ご家族向けの説明文をお願いします")).toBeNull();
  });

  it("空入力・非該当の数値・日付表記を誤爆しない", () => {
    expect(detectPii("")).toBeNull();
    expect(detectPii("0050")).toBeNull();
    expect(detectPii("1005")).toBeNull();
    expect(detectPii("37.9℃")).toBeNull();
    expect(detectPii("7/10")).toBeNull();
  });

  it("同じ入力を繰り返し判定しても結果が変わらない", () => {
    const text = `${stage4Patient.name}さんの件です`;
    expect(detectPii(text)).toBe("患者氏名");
    expect(detectPii(text)).toBe("患者氏名");
  });

  it("複数該当時はパターン順で先に定義したラベルを返す", () => {
    const text = `${stage4Patient.name}さん（患者ID ${stage4Patient.id}）の件です`;
    expect(detectPii(text)).toBe("患者氏名");
  });
});
