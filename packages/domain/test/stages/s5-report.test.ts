import { stage5FeverRows, stage5IncidentReport } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { containsPii, detectPii } from "../../src/pii.js";
import { judgeS5Report } from "../../src/stages/s5-report.js";
import { nonPiiIndices, piiIndices, plainIndices } from "./s5-report-indices.js";

describe("stage5IncidentReport（黒塗りの報告書）", () => {
  it("塗るべき語と塗ってはいけない語の両方がある", () => {
    expect(piiIndices.length).toBeGreaterThan(0);
    expect(nonPiiIndices.length).toBeGreaterThan(0);
  });

  it("塗ってはいけない語（ID・病棟・日付・体温など）は送信前ゲートでも個人情報ではない", () => {
    for (const i of nonPiiIndices) {
      expect(detectPii(stage5IncidentReport[i]?.t ?? "")).toBeNull();
    }
  });

  it("発熱患者一覧の氏名を含む片は、どれも塗るべき語で、報告書に1名以上いる", () => {
    const names = stage5FeverRows.map(({ name }) => name);
    const withName = stage5IncidentReport.filter(({ t }) => names.some((name) => t.includes(name)));
    expect(withName.length).toBeGreaterThan(0);
    for (const segment of withName) expect(segment.pii).toBe(true);
  });

  it("連絡先は実在しない値だけを使う", () => {
    const texts = piiIndices.map((i) => stage5IncidentReport[i]?.t ?? "");
    const mails = texts.filter((text) => text.includes("@"));
    const phones = texts.filter((text) => /^\d{3}-\d{4}-\d{4}$/.test(text));
    expect(mails.length).toBe(3);
    expect(mails.every((mail) => mail.endsWith("@example.com"))).toBe(true);
    expect(phones.length).toBe(3);
    expect(phones.every((phone) => phone.startsWith("090-0000-"))).toBe(true);
  });
});

describe("judgeS5Report（黒塗りの提出）", () => {
  it("塗るべき語をすべて塗り、ほかを塗らなければ合格する", () => {
    expect(judgeS5Report(piiIndices)).toEqual({ outcome: "pass" });
  });

  it("地の文の添字や報告書の外の添字が混ざっても合否に影響しない", () => {
    expect(
      judgeS5Report([...piiIndices, ...plainIndices, -1, stage5IncidentReport.length, 999]),
    ).toEqual({
      outcome: "pass",
    });
  });

  it("同じ添字が重複していても1回として扱う", () => {
    expect(judgeS5Report([...piiIndices, ...piiIndices])).toEqual({ outcome: "pass" });
  });

  it("何も塗らずに出せば塗り残しとして差し戻す", () => {
    expect(judgeS5Report([])).toEqual({ outcome: "reject", missing: true, over: false });
  });

  it("塗るべき語を1つでも残せば差し戻す（最後の1つ）", () => {
    expect(judgeS5Report(piiIndices.slice(0, -1))).toEqual({
      outcome: "reject",
      missing: true,
      over: false,
    });
  });

  it("塗るべき語を1つでも残せば差し戻す（最初の1つ）", () => {
    expect(judgeS5Report(piiIndices.slice(1))).toEqual({
      outcome: "reject",
      missing: true,
      over: false,
    });
  });

  it.each(nonPiiIndices)("塗ってはいけない語（添字%i）を塗れば塗りすぎとして差し戻す", (i) => {
    expect(judgeS5Report([...piiIndices, i])).toEqual({
      outcome: "reject",
      missing: false,
      over: true,
    });
  });

  it("塗り残しと塗りすぎは同時に返す", () => {
    expect(judgeS5Report(nonPiiIndices)).toEqual({ outcome: "reject", missing: true, over: true });
  });

  it("判定結果に報告書の本文を写さない", () => {
    for (const masked of [[], piiIndices, nonPiiIndices]) {
      expect(containsPii(judgeS5Report(masked))).toBe(false);
      expect(JSON.stringify(judgeS5Report(masked))).not.toContain("example.com");
    }
  });
});
