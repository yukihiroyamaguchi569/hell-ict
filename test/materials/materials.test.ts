import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const materialsPath = (name: string): string =>
  resolve(import.meta.dirname, "../../docs/materials", name);

const parseTsv = async (name: string): Promise<readonly (readonly string[])[]> => {
  const contents = await readFile(materialsPath(name), "utf8");
  return contents
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
};

describe("教材の整合性", () => {
  it("Stage 2の配布TSVは7列で、設計どおりの患者・ノイズ行数を持つ", async () => {
    const rows = await parseTsv("stage2_linelist.tsv");
    const patientRows = rows.filter((row) => row.length >= 6);
    const noiseRows = rows.filter((row) => row.length < 6);

    expect(rows).toHaveLength(23);
    expect(patientRows).toHaveLength(20);
    expect(noiseRows).toHaveLength(3);
  });

  it("患者005の固有情報はStage 2 TSVとStage 4カルテで一致する", async () => {
    const rows = await parseTsv("stage2_linelist.tsv");
    const patient = rows.find((row) => row[0] === "005");
    const chart = await readFile(materialsPath("stage4_chart.md"), "utf8");

    expect(patient?.slice(0, 6)).toEqual(["005", "渡辺 三郎", "5A", "7.3", "陰性", "37.9℃"]);
    expect(chart).toContain("渡辺 三郎");
    expect(chart).toContain("患者ID 005");
  });
});
