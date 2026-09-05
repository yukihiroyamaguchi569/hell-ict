import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { detectPii, stage4Patient } from "../../packages/domain/src/pii.js";
import { parseTsv } from "./parse-tsv.js";

const materialsPath = (name: string): string =>
  resolve(import.meta.dirname, "../../docs/materials", name);

const readTsv = async (name: string): Promise<readonly (readonly string[])[]> =>
  parseTsv(await readFile(materialsPath(name), "utf8"));

const materialExpectations = [
  { name: "stage2_linelist.tsv", patientCount: 20, noiseCount: 2, rowCount: 22 },
  { name: "stage2_linelist.annotated.tsv", patientCount: 20, noiseCount: 2, rowCount: 22 },
  { name: "stage2_linelist_addendum.tsv", patientCount: 10, noiseCount: 0, rowCount: 10 },
] as const;

describe("教材の整合性", () => {
  // 列は患者ID/病棟/採取日/MRSA結果/発熱/備考の6列固定（氏名列は削除済み——
  // 実AI接続でStage 2の正規タスク（グリッドをAIに整形させる）を行うと、
  // 旧・氏名列の値「渡辺 三郎」がStage 4のPII検知パターン（`stage4Patient.name`）と
  // そのまま一致し、Stage 2の実作業がPIIゲートに誤射ブロックされていたため）。
  it.each(materialExpectations)("$nameは患者6列と設計どおりの行数を持つ", async (material) => {
    const rows = await readTsv(material.name);
    const patientRows = rows.filter((row) => row.length === 6);
    const noiseRows = rows.filter((row) => row.length !== 6);

    expect(rows).toHaveLength(material.rowCount);
    expect(patientRows).toHaveLength(material.patientCount);
    expect(noiseRows).toHaveLength(material.noiseCount);
    expect(patientRows.every((row) => row.length === 6)).toBe(true);
  });

  it("stage2_linelist.tsvに氏名列は存在しない（PII誤検知回避のため削除済み）", async () => {
    const text = await readFile(materialsPath("stage2_linelist.tsv"), "utf8");
    expect(text).not.toContain("渡辺");
    expect(text).not.toContain(stage4Patient.name);
  });

  it("CRLFと末尾空列を保持し、終端改行だけを取り除く", () => {
    expect(parseTsv("001\t佐藤\t5A\t7/3\t陽性\tあり\t\r\n")).toEqual([
      ["001", "佐藤", "5A", "7/3", "陽性", "あり", ""],
    ]);
  });

  it("患者005の固有情報はStage 2 TSVとStage 4カルテで一致する（氏名はStage 4のみ）", async () => {
    const rows = await readTsv("stage2_linelist.tsv");
    const patient = rows.find((row) => row[0] === "005");
    const chart = await readFile(materialsPath("stage4_chart.md"), "utf8");

    // ID・病棟・採取日・MRSA結果・発熱で一致させる。氏名はStage 2から削除済みで、
    // Stage 4カルテ抜粋で初めて明かされる（stage4_chart.md 実装メモ参照）。
    expect(patient?.slice(0, 5)).toEqual(["005", "5A", "7.3", "陰性", "37.9℃"]);
    expect(chart).toContain("渡辺 三郎");
    expect(chart).toContain("患者ID 005");
  });

  it("Stage 4カルテはdetectPiiの検知パターン（stage4Patient）5値すべてを含む", async () => {
    const chart = await readFile(materialsPath("stage4_chart.md"), "utf8");
    expect(chart).toContain(stage4Patient.name);
    expect(chart).toContain(stage4Patient.id);
    expect(chart).toContain(stage4Patient.dob);
    expect(chart).toContain(stage4Patient.phone);
    expect(chart).toContain(stage4Patient.familyName);
  });

  it("Stage 4カルテの経過欄はdetectPiiで検知される", async () => {
    const chart = await readFile(materialsPath("stage4_chart.md"), "utf8");
    const line = chart
      .split("\n")
      .find((row) => row.includes("患者ID") && row.includes(stage4Patient.name));
    expect(line).toBeDefined();
    expect(detectPii(line ?? "")).not.toBeNull();
  });

  it("塗ってはいけない一般語は単体では検知されない", () => {
    for (const general of ["5A病棟", "7月10日", "原因不明の発熱（精査中）", "感染制御チーム"]) {
      expect(detectPii(general)).toBeNull();
    }
  });

  // Stage 4再設計（家族返信→保健所への発熱患者一覧提出）の罠教材。Stage 2とは対句で、
  // こちらは氏名列を「あえて残す」——丸ごとAIに貼ると個人名がPIIゲートに触れるべき罠
  // （docs/materials/stage4_fever_linelist.md 実装メモ参照）。
  describe("stage4_fever_linelist.tsv（発熱患者一覧・罠の実体）", () => {
    it("発熱患者14名分、患者ID/氏名/病棟/発熱確認日/最高体温/備考の6列を持つ", async () => {
      const rows = await readTsv("stage4_fever_linelist.tsv");
      expect(rows).toHaveLength(14);
      expect(rows.every((row) => row.length === 6)).toBe(true);
    });

    it("患者IDに重複が無い", async () => {
      const rows = await readTsv("stage4_fever_linelist.tsv");
      const ids = rows.map((row) => row[0]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("Stage 2とは対句で氏名列を持つ（罠の実体そのもの）", async () => {
      const text = await readFile(materialsPath("stage4_fever_linelist.tsv"), "utf8");
      expect(text).toContain(stage4Patient.name);
    });

    it("患者005の行は病棟・発熱確認日・最高体温がstage4_chart.mdと整合する", async () => {
      const rows = await readTsv("stage4_fever_linelist.tsv");
      const patient = rows.find((row) => row[0] === "005");

      expect(patient?.slice(0, 5)).toEqual(["005", stage4Patient.name, "5A", "7/3", "38.1℃"]);
    });

    // 名簿とPII検知パターン（packages/domain/src/pii.ts §feverLinelistPatientNames）の
    // 網羅一致を固定する。pii.test.ts は代表数名しか見ないので、名簿へ1名足して
    // パターン側を足し忘れると、その1名の氏名だけがゲートをすり抜けてOpenAIへ届く
    // ——教材とパターンが別々の場所にある以上、この対応漏れは静かに起きる
    // （企画書§7「ダミー個人情報を実際に外部へ送信しない」の最後の防波堤）。
    // 全氏名を1件ずつ検査し、姓名間の空白を除いた表記でも検知することまで見る。
    it("名簿の全氏名が送信前ゲートで検知される（1名の取りこぼしも許さない）", async () => {
      const rows = await readTsv("stage4_fever_linelist.tsv");
      const names = rows.map((row) => row[1] ?? "");

      expect(names.every((name) => name.length > 0)).toBe(true);
      for (const name of names) {
        expect(detectPii(`${name}さんの件です`)).toBe("患者氏名");
        expect(detectPii(`${name.replace(/\s/gu, "")}さんの件です`)).toBe("患者氏名");
      }
    });

    // 名簿を丸ごと貼る（＝罠そのもの）とゲートが必ず止めることを、実際の
    // ファイル本文で確認する。行単位でも1行残らず止まることまで見る。
    it("名簿を丸ごと貼っても行ごとに貼っても検知される", async () => {
      const text = await readFile(materialsPath("stage4_fever_linelist.tsv"), "utf8");

      expect(detectPii(text)).toBe("患者氏名");
      for (const line of text.split("\n").filter((row) => row.trim() !== "")) {
        expect(detectPii(line)).toBe("患者氏名");
      }
    });
  });
});
