import { handoverNotes, stage1ClearAdminLines, stageClears } from "@hell-ict/content";
import { gameViewResponseSchema, HANDOVER_STAGE_IDS, teamGameScene } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  clearPortraitSrcs,
  clearSheets,
  DEFAULT_ART_POSITION,
  stage1ClearResult,
} from "../../src/overlays/clear-sheets.js";
import { OVERLAY_PRIORITY, pickOverlay } from "../../src/overlays/overlay-priority.js";
import { START_MS, viewBody } from "../fakes.js";

const PLAYED = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

describe("pickOverlay（同時に出すのは1つ、優先順位の高いもの）", () => {
  it("何も求められていなければ出さない", () => {
    expect(pickOverlay([])).toBeNull();
  });

  it("ひとつだけならそれ", () => {
    for (const overlay of OVERLAY_PRIORITY) expect(pickOverlay([overlay])).toBe(overlay);
  });

  it("古いタブの案内はクリア演出より上（古いタブから advance を押させない）", () => {
    expect(pickOverlay(["clear", "stale"])).toBe("stale");
    expect(pickOverlay(["clear", "entry"])).toBe("entry");
    expect(pickOverlay(["entry", "opening"])).toBe("opening");
    expect(pickOverlay(["entry", "stale", "clear"])).toBe("stale");
  });

  it("ステージの窓はクリア演出の下、ビューアの上", () => {
    expect(pickOverlay(["stage", "clear"])).toBe("clear");
    expect(pickOverlay(["viewer", "stage"])).toBe("stage");
    expect(pickOverlay(["stage", "entry"])).toBe("entry");
    expect(pickOverlay(["stage", "stale"])).toBe("stale");
  });

  it("ビューアは最下位：ゲームが出すものの下で待ち、それが消えたら戻る", () => {
    expect(OVERLAY_PRIORITY.at(-1)).toBe("viewer");
    expect(pickOverlay(["viewer", "clear"])).toBe("clear");
    expect(pickOverlay(["viewer", "entry"])).toBe("entry");
    expect(pickOverlay(["viewer", "stale"])).toBe("stale");
  });
});

describe("clearSheets", () => {
  it("①の見出しと副題・②③の全画面の絵と名札と台詞はステージの STAGE_CLEAR から", () => {
    const sheets = clearSheets("s3", null);
    expect(sheets.title).toBe("Stage 3 をクリアしました");
    expect(sheets.sub).toBe(stageClears.s3.sub);
    expect(sheets.sfx).toBe("success1");
    expect(sheets.field).toEqual({
      art: {
        src: "/assets/images/production/stage3-ward-3b-head-nurse-clear.webp",
        position: DEFAULT_ART_POSITION,
      },
      name: "3B病棟 看護師長",
      lines: stageClears.s3.field.lines,
    });
    // 所属の無い話者は役職だけ。
    expect(sheets.exec).toEqual({
      art: {
        src: "/assets/images/production/stage3-nursing-director-clear.webp",
        position: DEFAULT_ART_POSITION,
      },
      name: "看護部長",
      lines: stageClears.s3.exec,
    });
  });

  it("③の絵はステージが持つ：同じ看護部長でも Stage 2 と 3 で別の絵、事務長も 1・5・6 で別", () => {
    expect(clearSheets("s2", null).exec.name).toBe(clearSheets("s3", null).exec.name);
    expect(clearSheets("s2", null).exec.art.src).not.toBe(clearSheets("s3", null).exec.art.src);
    const jimu = (["s1", "s5", "s6"] as const).map((stage) => clearSheets(stage, null).exec);
    expect(new Set(jimu.map((card) => card.name))).toEqual(new Set(["病院執行部 事務長"]));
    expect(new Set(jimu.map((card) => card.art.src)).size).toBe(3);
  });

  it("②③の12枚はすべて別の絵で、どれも production の WebP", () => {
    const srcs = PLAYED.flatMap((stage) => {
      const { field, exec } = clearSheets(stage, null);
      return [field.art.src, exec.art.src];
    });
    expect(new Set(srcs).size).toBe(12);
    for (const src of srcs)
      expect(src).toMatch(/^\/assets\/images\/production\/[a-z0-9-]+\.webp$/u);
  });

  it("②③は台詞を1行以上持ち、名札は空にならない", () => {
    for (const stage of PLAYED) {
      for (const card of [clearSheets(stage, "ai").field, clearSheets(stage, "ai").exec]) {
        expect(card.lines.length).toBeGreaterThan(0);
        expect(card.name).not.toBe("");
        expect(card.name.startsWith(" ")).toBe(false);
      }
    }
  });

  it("Stage 1 は効果音を鳴らさず（結果ウィンドウが鳴らした）、副題も無い", () => {
    const sheets = clearSheets("s1", "manual");
    expect(sheets.sfx).toBeNull();
    expect(sheets.sub).toBe("");
  });

  it("Stage 1 の③は、片付け方で変わる事務長の評価が先頭に付く", () => {
    expect(clearSheets("s1", "manual").exec.lines).toEqual([
      stage1ClearAdminLines.manual,
      ...stageClears.s1.exec,
    ]);
    expect(clearSheets("s1", "ai").exec.lines).toEqual([
      stage1ClearAdminLines.ai,
      ...stageClears.s1.exec,
    ]);
    // 状態が片付け方を言わないときは固定の1行だけ（落ちない）。
    expect(clearSheets("s1", null).exec.lines).toEqual(stageClears.s1.exec);
    // Stage 1 以外は評価を付けない。
    expect(clearSheets("s2", "manual").exec.lines).toEqual(stageClears.s2.exec);
  });

  it("④の文面は、domain が交代の案内を出すステージとちょうど同じステージにだけある", () => {
    expect(Object.keys(handoverNotes).sort()).toEqual([...HANDOVER_STAGE_IDS].sort());
    for (const stage of PLAYED) {
      const handover = teamGameScene({
        game: {
          stage,
          clearedAt: { [stage]: "2026-10-31T01:00:00.000Z" },
          penalties: { s3: "none", s5: "none" },
        },
        inbox: null,
      });
      expect(handover.kind === "clear-sequence" && handover.handover).toBe(
        clearSheets(stage, null).handover !== null,
      );
    }
    expect(clearSheets("s4", null).handover).toEqual(handoverNotes.s4);
  });
});

describe("clearPortraitSrcs（ステージ中に先読みするクリア演出の全画面の絵）", () => {
  it.each(PLAYED)("%s は②の現場スタッフと③の幹部の全画面の絵の2枚だけ", (stage) => {
    expect(clearPortraitSrcs(stage)).toEqual([
      `/assets/images/production/${stageClears[stage].field.fullscreen.img}`,
      `/assets/images/production/${stageClears[stage].execFullscreen.img}`,
    ]);
  });

  it("②③が実際に出す src と同じ（Stage 1 は片付け方によらず同じ事務長の絵）", () => {
    for (const stage of PLAYED) {
      for (const result of ["manual", "ai", null] as const) {
        const { field, exec } = clearSheets(stage, result);
        expect(clearPortraitSrcs(stage)).toEqual([field.art.src, exec.art.src]);
      }
    }
  });

  it("ほかのステージの絵は混ぜない（12枚を一度に読まない）", () => {
    for (const stage of PLAYED) {
      const others = PLAYED.filter((other) => other !== stage).flatMap(clearPortraitSrcs);
      for (const src of clearPortraitSrcs(stage)) expect(others).not.toContain(src);
    }
  });

  it("クリア演出の無い Prologue と Final は何も先読みしない", () => {
    expect(clearPortraitSrcs("prologue")).toEqual([]);
    expect(clearPortraitSrcs("final")).toEqual([]);
  });
});

describe("stage1ClearResult", () => {
  const BASE = gameViewResponseSchema.parse(viewBody(1)).state;
  const s1 = (status: NonNullable<TeamGameViewState["s1"]>["status"]): TeamGameViewState => ({
    ...BASE,
    s1: {
      stageStartedAt: START_MS,
      round: 2,
      roundStartedAt: START_MS,
      r3Try: 0,
      doneIds: [],
      curt: [],
      memoReplied: false,
      status,
    },
  });

  it("クリア済みなら片付け方、それ以外は null", () => {
    expect(stage1ClearResult(BASE)).toBeNull();
    expect(stage1ClearResult(s1({ phase: "playing" }))).toBeNull();
    expect(stage1ClearResult(s1({ phase: "round-result", failure: "round2" }))).toBeNull();
    expect(stage1ClearResult(s1({ phase: "cleared", result: "ai" }))).toBe("ai");
    expect(stage1ClearResult(s1({ phase: "cleared", result: "manual" }))).toBe("manual");
  });
});
