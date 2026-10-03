import {
  stage6GenerateMs,
  stage6RejectType,
  stage6RequirementRejects,
  stage6SendFailed,
  stage6SoudanMail,
} from "@hell-ict/content";
import { gameCommandResponseSchema } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import type { SendOutcome } from "../../../src/composables/use-game-session.js";
import {
  STAGE6_ROWS,
  stage6GenerateResult,
  stage6KarubeCalls,
  stage6SubmitResult,
  stage6Turns,
  stage6Verdict,
} from "../../../src/stages/s6/s6-view.js";
import { START_MS, viewBody } from "../../fakes.js";

/*
 * The pure parts the composable's tests (use-stage6.test.ts) do not reach through the server.
 */

const done = (body: Record<string, unknown>): SendOutcome => ({
  kind: "done",
  response: gameCommandResponseSchema.parse({ ...viewBody(5), ...body }),
});
const applied = (judgement: unknown) => done({ status: "applied", events: [], judgement });

it("受信トレイは近藤さん（去年の掲示物）が上、事務長が下で、それぞれのビューアを開く", () => {
  expect(STAGE6_ROWS.map((row) => [row.id, row.opens, row.attach])).toEqual([
    ["s6soudan", { kind: "viewer", doc: "s6notice" }, stage6SoudanMail.attach],
    ["s6jimu", { kind: "viewer", doc: "s6jimu" }, undefined],
  ]);
});

it("言った位置が turns の数を超えたメモは末尾に置く", () => {
  const notes = [{ id: -1, text: "後", reply: null, after: 9 }];
  const s6 = { promptLog: ["絵で"], candidates: ["pictogram" as const] };
  const turns = stage6Turns(s6, { hideFrom: null, generating: [], notes }, () => undefined);
  expect(turns.map((turn) => turn.id)).toEqual([0, -1]);
});

it("生成待ちの turn だけが 2.5 秒の待ち時間を持ち、描かれた候補とメモには付かない", () => {
  const notes = [{ id: -1, text: "メモ", reply: null, after: 1 }];
  const s6 = { promptLog: ["絵で"], candidates: ["pictogram" as const] };
  const generating = [{ id: 1, text: "直して" }];
  const turns = stage6Turns(s6, { hideFrom: null, generating, notes }, () => undefined);
  expect(turns.map((turn) => [turn.id, turn.waitingMs])).toEqual([
    [0, undefined],
    [-1, undefined],
    [1, stage6GenerateMs],
  ]);
  expect(stage6GenerateMs).toBe(2_500);
});

describe("生成の応答", () => {
  it("重複は最初の判定の index、読めない判定は lost、古いタブは none", () => {
    const duplicate = done({
      status: "duplicate",
      original: { events: [], judgement: { index: 2, type: "default" } },
    });
    expect(stage6GenerateResult(duplicate)).toEqual({ kind: "made", index: 2 });
    expect(stage6GenerateResult(applied({ index: -1, type: "pictogram" }))).toEqual({
      kind: "lost",
    });
    expect(stage6GenerateResult({ kind: "unavailable" })).toEqual({ kind: "lost" });
    expect(stage6GenerateResult({ kind: "stale" })).toEqual({ kind: "none" });
    const moved = done({ status: "rejected", reason: "stage-mismatch", judgement: null });
    expect(stage6GenerateResult(moved)).toEqual({ kind: "none" });
  });
});

describe("提出の応答と判定の箱", () => {
  it.each([
    ["textheavy", stage6RejectType.textheavy],
    ["default", stage6RejectType.default],
    ["mask", stage6RequirementRejects.mask],
    ["visiting-hours", stage6RequirementRejects.visitingHours],
  ])("差し戻し %s は近藤さんの台詞", (reason, line) => {
    expect(stage6SubmitResult(applied({ outcome: "reject", reason }))).toEqual({
      kind: "sent-back",
      line,
    });
  });

  it("送り直しで返った duplicate は、最初の判定の差し戻しをもう一度言う", () => {
    const duplicate = done({
      status: "duplicate",
      original: { events: [], judgement: { outcome: "reject", reason: "mask" } },
    });
    expect(stage6SubmitResult(duplicate)).toEqual({
      kind: "sent-back",
      line: stage6RequirementRejects.mask,
    });
  });

  it("通った提出と、知らない差し戻し理由は accepted", () => {
    expect(stage6SubmitResult(applied({ outcome: "pass" }))).toEqual({ kind: "accepted" });
    expect(stage6SubmitResult(applied({ outcome: "reject", reason: "unknown" }))).toEqual({
      kind: "accepted",
    });
  });

  it.each(["unavailable", "failed"] as const)("%s は送り直せる", (kind) => {
    expect(stage6SubmitResult({ kind })).toEqual({ kind: "retry" });
  });

  it.each(["stale", "superseded"] as const)("%s は何も言わない", (kind) => {
    expect(stage6SubmitResult({ kind })).toEqual({ kind: "none" });
  });

  it("候補の無い拒否と古いタブは none、判定中が先で、送れなかった一行はクリア前だけ", () => {
    const missing = done({ status: "rejected", reason: "no-candidate", judgement: null });
    expect(stage6SubmitResult(missing)).toEqual({ kind: "none" });
    expect(stage6SubmitResult({ kind: "not-ready" })).toEqual({ kind: "none" });
    expect(stage6Verdict(true, null, true)).toEqual({ kind: "checking" });
    expect(stage6Verdict(false, { kind: "retry" }, true)?.kind).toBe("cleared");
    expect(stage6Verdict(false, { kind: "retry" }, false)).toEqual({
      kind: "rejected",
      lines: [stage6SendFailed],
    });
    expect(stage6Verdict(false, { kind: "accepted" }, false)).toBeNull();
  });
});

it("苅部さんはクリア後と入場前は鳴らない", () => {
  const entered = new Date(START_MS).toISOString();
  expect(stage6KarubeCalls(entered, START_MS + 90_000, true)).toEqual([]);
  expect(stage6KarubeCalls(null, START_MS + 90_000, false)).toEqual([]);
});
