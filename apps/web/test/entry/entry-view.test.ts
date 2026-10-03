import { describe, expect, it } from "vitest";

import type { GameSessionStatus } from "../../src/composables/use-game-session.js";
import {
  checkEntry,
  entryNotice,
  isHealthy,
  joinErrorMessage,
  nameAfterCodeChange,
  normalizeTeamName,
  teamChipText,
  TEAM_NAME_MAX,
  type ProbeState,
} from "../../src/entry/entry-view.js";

describe("checkEntry", () => {
  it("6桁のコードとチーム名がそろえば通す（名前は前後の空白を落とす）", () => {
    expect(checkEntry("012345", "  発熱対策室 ")).toEqual({
      ok: true,
      teamCode: "012345",
      teamName: "発熱対策室",
    });
  });

  it("チーム名が空・空白だけなら、コードより先に名前を求める", () => {
    for (const name of ["", "   ", "\t"]) {
      const result = checkEntry("12", name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("チーム名を入力してください");
    }
  });

  it("コードが6桁のASCII数字でなければ拒否する", () => {
    for (const code of ["", "12345", "1234567", "12345a", "１２３４５６", " 12345"]) {
      const result = checkEntry(code, "A班");
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.message).toBe("チームコードはASCII数字6桁で入力してください。");
    }
  });

  it("長すぎる名前はチップに収まる長さで切る", () => {
    const result = checkEntry("123456", "あ".repeat(TEAM_NAME_MAX + 3));
    expect(result.ok && result.teamName).toBe("あ".repeat(TEAM_NAME_MAX));
    expect(normalizeTeamName("x".repeat(TEAM_NAME_MAX))).toHaveLength(TEAM_NAME_MAX);
  });
});

describe("isHealthy", () => {
  it("status: ok と guards のオブジェクトがあるときだけ健康とみなす", () => {
    expect(isHealthy({ status: "ok", guards: {}, ai: {} })).toBe(true);
    expect(isHealthy({ status: "ok", guards: { origin: "strict" } })).toBe(true);
  });

  it("静的ホスティングが返す HTML や、形の違う本文は健康とみなさない", () => {
    for (const body of [
      null,
      "<!doctype html>",
      {},
      { status: "ok" },
      { status: "ok", guards: null },
      { status: "ok", guards: "on" },
      { status: "degraded", guards: {} },
    ]) {
      expect(isHealthy(body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe("entryNotice", () => {
  const notice = (probe: ProbeState, status: GameSessionStatus = "idle", entering = false) =>
    entryNotice({ probe, status, entering });

  it("疎通確認が終わるまでは入室させない", () => {
    expect(notice("pending")).toEqual({
      text: "接続を確認しています…",
      bad: false,
      retry: null,
      canEnter: false,
    });
    // 復元の最中でも、確認前なら同じ
    expect(notice("pending", "joining").canEnter).toBe(false);
  });

  it("API が答えなければエラーと［再試行］（疎通確認のやり直し）だけを出す", () => {
    expect(notice("failed")).toEqual({
      text: "サーバに接続できません。ネットワークを確認して再試行してください。",
      bad: true,
      retry: "probe",
      canEnter: false,
    });
  });

  it("フォームからの入室中は重ねて押させない", () => {
    expect(notice("ok", "joining", true)).toEqual({
      text: "入室しています…",
      bad: false,
      retry: null,
      canEnter: false,
    });
  });

  it("復元に失敗したら［再試行］は復元のやり直しで、入室はさせない", () => {
    expect(notice("ok", "restore-failed")).toEqual({
      text: "復元に失敗しました。ネットワークを確認して再試行してください。",
      bad: true,
      retry: "restore",
      canEnter: false,
    });
  });

  it("復元の最中はフォームを使える（後から始めた入室が勝つ）", () => {
    expect(notice("ok", "joining")).toEqual({
      text: "前回のチームへ戻っています…",
      bad: false,
      retry: null,
      canEnter: true,
    });
  });

  it("何も起きていなければ静かに入室を待つ", () => {
    for (const status of ["idle", "ready", "stale"] as const) {
      expect(notice("ok", status)).toEqual({ text: "", bad: false, retry: null, canEnter: true });
    }
  });
});

describe("joinErrorMessage", () => {
  it("失敗の種類ごとに案内を出し、成功と追い越しには何も出さない", () => {
    expect(joinErrorMessage("not-found")).toContain("コードを確かめてください");
    expect(joinErrorMessage("failed")).toContain("時間を置いて再試行してください");
    expect(joinErrorMessage("ok")).toBe("");
    expect(joinErrorMessage("superseded")).toBe("");
  });
});

describe("teamChipText", () => {
  it("名前があれば名前、無ければコード、どちらも無ければ空", () => {
    expect(teamChipText("発熱対策室", "123456")).toBe("発熱対策室");
    expect(teamChipText("", "123456")).toBe("123456");
    expect(teamChipText("", null)).toBe("");
  });
});

describe("nameAfterCodeChange", () => {
  it("手で打った名前は、コードを直しても消さない", () => {
    expect(nameAfterCodeChange({ current: "A班", stored: "B班", typed: true })).toBe("A班");
    expect(nameAfterCodeChange({ current: "A班", stored: "", typed: true })).toBe("A班");
  });

  it("手で打っていなければ、そのコードで残した名前に替える", () => {
    expect(nameAfterCodeChange({ current: "", stored: "B班", typed: false })).toBe("B班");
    expect(nameAfterCodeChange({ current: "A班", stored: "B班", typed: false })).toBe("B班");
  });

  it("別のチームの名前を持ち越さない（残した名前が無いコードに直したら空にする）", () => {
    expect(nameAfterCodeChange({ current: "A班", stored: "", typed: false })).toBe("");
  });
});
