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
  { name: "stage2_linelist.tsv", patientCount: 20, noiseCount: 3, rowCount: 23 },
  { name: "stage2_linelist.annotated.tsv", patientCount: 20, noiseCount: 3, rowCount: 23 },
  { name: "stage2_linelist_addendum.tsv", patientCount: 10, noiseCount: 0, rowCount: 10 },
] as const;

describe("教材の整合性", () => {
  it.each(materialExpectations)("$nameは患者7列と設計どおりの行数を持つ", async (material) => {
    const rows = await readTsv(material.name);
    const patientRows = rows.filter((row) => row.length === 7);
    const noiseRows = rows.filter((row) => row.length !== 7);

    expect(rows).toHaveLength(material.rowCount);
    expect(patientRows).toHaveLength(material.patientCount);
    expect(noiseRows).toHaveLength(material.noiseCount);
    expect(patientRows.every((row) => row.length === 7)).toBe(true);
  });

  it("CRLFと末尾空列を保持し、終端改行だけを取り除く", () => {
    expect(parseTsv("001\t佐藤\t5A\t7/3\t陽性\tあり\t\r\n")).toEqual([
      ["001", "佐藤", "5A", "7/3", "陽性", "あり", ""],
    ]);
  });

  it("患者005の固有情報はStage 2 TSVとStage 4カルテで一致する", async () => {
    const rows = await readTsv("stage2_linelist.tsv");
    const patient = rows.find((row) => row[0] === "005");
    const chart = await readFile(materialsPath("stage4_chart.md"), "utf8");

    expect(patient?.slice(0, 6)).toEqual(["005", "渡辺 三郎", "5A", "7.3", "陰性", "37.9℃"]);
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
});
