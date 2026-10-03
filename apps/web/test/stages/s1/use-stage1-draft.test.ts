import { rateLimitNotice, stage1DraftLabels } from "@hell-ict/content";
import type { Stage1State } from "@hell-ict/domain";
import { FakeClock } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { computed, effectScope, nextTick, ref } from "vue";

import type { HttpResponse } from "../../../src/ports.js";
import { stage1Rows } from "../../../src/stages/s1/s1-view.js";
import {
  STAGE1_DRAFT_NO_MATERIAL_MS,
  STAGE1_DRAFT_NOTICE_MS,
  stage1DraftRecordFor,
  useStage1Draft,
} from "../../../src/stages/s1/use-stage1-draft.js";
import type { Stage1DraftRecord } from "../../../src/stages/s1/use-stage1-draft.js";
import {
  chatMessageBody,
  chatSnapshotBody,
  deferred,
  FakeHttp,
  FakeKeyValueStorage,
  FakeScheduler,
  flush,
  ok,
  staleGeneration,
  unavailable,
} from "../../fakes.js";
import { appliedWith, fakeSession, stage1, T0, viewIn } from "./fake-session.js";

const DRAFT_KEY = "hellVueStage1Draft:123456";
const PENDING_KEY = "hellStage1DraftPending:123456";
const DRAFTED = "お問い合わせの件、確認して折り返します。";
const THREAD = "11111111-1111-4111-8111-111111111111";

const round2 = (patch: Partial<Stage1State> = {}): Stage1State => stage1({ round: 2, ...patch });
const round3 = (r3Try: number, roundStartedAt: number): Stage1State =>
  stage1({ round: 3, r3Try, roundStartedAt });

const drafted = (): HttpResponse =>
  ok({
    snapshot: chatSnapshotBody(2, { [THREAD]: [] }),
    assistant: chatMessageBody(2, "assistant", DRAFTED),
  });
const refused = (status: number, code: string, extra: object = {}): HttpResponse => ({
  status,
  body: { message: "だめです。", code, ...extra },
});

const mount = (
  s1: Stage1State | null = round2(),
  handler: (body: unknown) => HttpResponse | Promise<HttpResponse> = drafted,
  options: { now?: number; storage?: FakeKeyValueStorage } = {},
) => {
  const fake = fakeSession(viewIn(s1), () => appliedWith(viewIn(s1)));
  const serverNow = ref(options.now ?? T0 + 1_000);
  const state = computed(() => fake.view.value?.state.s1 ?? null);
  const rows = computed(() =>
    state.value === null ? [] : stage1Rows(state.value, serverNow.value),
  );
  const http = new FakeHttp((request) => handler(request.body));
  const scheduler = new FakeScheduler();
  const sessionStorage = options.storage ?? new FakeKeyValueStorage();
  const scope = effectScope();
  const draft = scope.run(() =>
    useStage1Draft({
      session: fake.session,
      stage: { state, rows },
      sessionStorage,
      scheduler,
      http,
      clock: new FakeClock(new Date(T0)),
    }),
  );
  if (draft === undefined) throw new Error("the scope did not run");
  return { ...fake, draft, http, scheduler, sessionStorage, serverNow, scope };
};

const sentIds = (http: FakeHttp): unknown[] =>
  http.requests.map((request) =>
    typeof request.body === "object" && request.body !== null && "commandId" in request.body
      ? request.body.commandId
      : null,
  );

describe("stage1DraftRecordFor: 挑戦ごとに区切る", () => {
  const filled = (s1: Stage1State): Stage1DraftRecord => ({
    stageStartedAt: s1.stageStartedAt,
    roundStartedAt: s1.roundStartedAt,
    round: s1.round,
    context: "引き継ぎメモ",
    bodies: { t1: "本文" },
    points: { t1: "要点" },
    memo: "メモ宛て",
  });

  it("同じ挑戦なら記録をそのまま返す", () => {
    const record = filled(round2());
    expect(stage1DraftRecordFor(record, round2())).toBe(record);
  });

  it("記録が無ければ空で始める", () => {
    expect(stage1DraftRecordFor(null, round2())).toMatchObject({ context: "", bodies: {} });
  });

  it("R3→R3 のやり直し（roundStartedAt だけ変わる）はコンテキストだけ残す", () => {
    const next = stage1DraftRecordFor(filled(round3(1, T0)), round3(2, T0 + 90_000));
    expect(next).toEqual({
      ...filled(round3(2, T0 + 90_000)),
      bodies: {},
      points: {},
      memo: "",
    });
  });

  it("ラウンドが変われば、コンテキストも消す", () => {
    expect(stage1DraftRecordFor(filled(round2()), round3(1, T0 + 90_000)).context).toBe("");
  });

  it("別のステージ開始（リセット後）なら全部消す", () => {
    const next = stage1DraftRecordFor(filled(round2()), round2({ stageStartedAt: T0 - 1 }));
    expect(next.context).toBe("");
  });
});

describe("useStage1Draft: 下書きの送信", () => {
  it("要点を渡すと s1-draft を1回送り、返事を本文へ入れて未確定の ID を捨てる", async () => {
    const { draft, http, sessionStorage, scheduler } = mount();
    draft.setPoint("r1", "確認して折り返す");
    const press = await draft.draft("r1");
    expect(press).toMatchObject({ kind: "sent", outcome: { kind: "ok" } });
    expect(http.requests).toEqual([
      {
        method: "POST",
        path: "/api/teams/123456/game/chat/messages",
        body: {
          type: "s1-draft",
          commandId: "cmd-1",
          generation: 3,
          mailId: "r1",
          context: "",
          point: "確認して折り返す",
        },
      },
    ]);
    expect(draft.body("r1")).toBe(DRAFTED);
    expect(sessionStorage.values.has(PENDING_KEY)).toBe(false);
    expect(draft.label("r1")).toBe(stage1DraftLabels.idle);
    expect(scheduler.pending).toBe(0);
  });

  it("送信中は「下書き中…」、二度押しても二重に送らない", async () => {
    const answer = deferred();
    const { draft, http } = mount(round2(), () => answer.promise);
    draft.context.value = "引き継ぎメモ";
    const first = draft.draft("r1");
    expect(draft.label("r1")).toBe(stage1DraftLabels.busy);
    expect(draft.busy("r1")).toBe(true);
    expect(await draft.draft("r1")).toEqual({ kind: "closed" });
    expect(await draft.draft("r2")).toEqual({ kind: "closed" });
    answer.resolve(drafted());
    await first;
    expect(http.requests).toHaveLength(1);
    expect(draft.busy("r1")).toBe(false);
  });

  it("要点もコンテキストも空なら送らず、1600ms ちょうどで文言を戻す", async () => {
    const { draft, http, scheduler } = mount();
    draft.setPoint("r1", "   ");
    expect(await draft.draft("r1")).toEqual({ kind: "no-material" });
    expect(http.requests).toEqual([]);
    expect(draft.label("r1")).toBe(stage1DraftLabels.noMaterial);
    expect(draft.label("r2")).toBe(stage1DraftLabels.idle);
    scheduler.advanceBy(STAGE1_DRAFT_NO_MATERIAL_MS - 1);
    expect(draft.label("r1")).toBe(stage1DraftLabels.noMaterial);
    scheduler.advanceBy(1);
    expect(draft.label("r1")).toBe(stage1DraftLabels.idle);
  });

  it("R1・結果窓・届いていないメール・締切を過ぎたメール・開始前は送らない（禁止遷移）", async () => {
    const cases: [Stage1State | null, number][] = [
      [stage1(), T0 + 1_000],
      [round2({ status: { phase: "round-result", failure: "round2" } }), T0 + 1_000],
      [round2(), T0 + 90_000],
      [null, T0 + 1_000],
    ];
    for (const [s1, now] of cases) {
      const { draft, http } = mount(s1, drafted, { now });
      draft.context.value = "引き継ぎメモ";
      expect(await draft.draft("r1")).toEqual({ kind: "closed" });
      expect(await draft.draft("r9")).toEqual({ kind: "closed" });
      expect(await draft.draft("m1")).toEqual({ kind: "closed" });
      expect(http.requests).toEqual([]);
    }
  });
});

describe("useStage1Draft: 失敗の後始末", () => {
  it("503 は ID を残し、同じ内容の押し直しは同じ ID、要点を変えたら新しい ID", async () => {
    const { draft, http } = mount(round2(), unavailable);
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    await draft.draft("r1");
    draft.setPoint("r1", "要点を書き足した");
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
  });

  it("失敗の文言は 2400ms ちょうどで戻り、次の押下で消える", async () => {
    const { draft, scheduler } = mount(round2(), unavailable);
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    expect(draft.label("r1")).toBe(stage1DraftLabels.failed);
    scheduler.advanceBy(STAGE1_DRAFT_NOTICE_MS - 1);
    expect(draft.label("r1")).toBe(stage1DraftLabels.failed);
    scheduler.advanceBy(1);
    expect(draft.label("r1")).toBe(stage1DraftLabels.idle);
  });

  it("結果不明の A の後に B を送っても、A に戻せば A の元の ID で送る", async () => {
    const { draft, http } = mount(round2(), unavailable);
    draft.setPoint("r1", "要点A");
    await draft.draft("r1");
    draft.setPoint("r1", "要点B");
    await draft.draft("r1");
    draft.setPoint("r1", "要点A");
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-2", "cmd-1"]);
  });

  it.each([
    ["503", unavailable],
    [
      "切断",
      (): HttpResponse => {
        throw new Error("offline");
      },
    ],
  ])("R3 の挑戦で %s の後、やり直しで同じ内容を押すと新しい ID で送る", async (_l, answer) => {
    const { draft, http, view, serverNow } = mount(round3(1, T0), answer);
    draft.context.value = "引き継ぎメモ";
    await draft.draft("t1");
    view.value = viewIn(round3(2, T0 + 90_000));
    serverNow.value = T0 + 91_000;
    await nextTick();
    await draft.draft("t1");
    await draft.draft("t1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-2", "cmd-2"]);
  });

  it("切断（応答なし）も結果が未確定なので ID を残す", async () => {
    const { draft, http, sessionStorage } = mount(round2(), () => {
      throw new Error("offline");
    });
    draft.context.value = "メモ";
    expect(await draft.draft("r1")).toMatchObject({ outcome: { kind: "saved-retry" } });
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-1"]);
    expect(sessionStorage.values.get(PENDING_KEY)).toContain("cmd-1");
  });

  it("429 は ID を残し、待つ秒数をボタンに出す（ゲームは読み直さない）", async () => {
    const { draft, refreshes, sessionStorage } = mount(round2(), () => ({
      status: 429,
      body: { message: "多すぎ", code: "rate_limited" },
      retryAfter: "7",
    }));
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    expect(draft.label("r1")).toBe(rateLimitNotice(7));
    expect(sessionStorage.values.has(PENDING_KEY)).toBe(true);
    expect(refreshes()).toBe(0);
  });

  it.each([
    ["draft_rejected", refused(409, "draft_rejected", { reason: "expired" })],
    ["pii_blocked", refused(422, "pii_blocked")],
    ["no_ai_chat", refused(409, "no_ai_chat")],
  ])("%s は ID を捨ててゲームを読み直す", async (_code, response) => {
    const { draft, http, refreshes, sessionStorage } = mount(round2(), () => response);
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-2"]);
    expect(refreshes()).toBe(2);
    expect(sessionStorage.values.has(PENDING_KEY)).toBe(false);
    expect(draft.label("r1")).toBe(stage1DraftLabels.failed);
  });

  it("stale は markStale し、文言は出さず ID を残す", async () => {
    const { draft, isStale, sessionStorage, scheduler } = mount(round2(), staleGeneration);
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    expect(isStale()).toBe(true);
    expect(draft.label("r1")).toBe(stage1DraftLabels.idle);
    expect(scheduler.pending).toBe(0);
    expect(sessionStorage.values.has(PENDING_KEY)).toBe(true);
  });

  it("返事が届く前に挑戦が変わったら、新しい挑戦の本文へは入れない", async () => {
    const answer = deferred();
    const { draft, view } = mount(round3(1, T0), () => answer.promise);
    draft.context.value = "引き継ぎメモ";
    const pressed = draft.draft("t1");
    view.value = viewIn(round3(2, T0 + 500));
    await nextTick();
    answer.resolve(drafted());
    await pressed;
    expect(draft.body("t1")).toBe("");
    expect(draft.context.value).toBe("引き継ぎメモ");
  });

  it("ステージを離れた（scope が止まった）後の返事は文言を出さない", async () => {
    const answer = deferred();
    const { draft, scope, scheduler } = mount(round2(), () => answer.promise);
    draft.setPoint("r1", "要点");
    const pressed = draft.draft("r1");
    scope.stop();
    answer.resolve(unavailable());
    await pressed;
    expect(scheduler.pending).toBe(0);
  });
});

describe("useStage1Draft: sessionStorage", () => {
  it("再読み込みで書きかけと未確定の ID が戻り、同じ内容なら同じ ID で送り直す", async () => {
    const storage = new FakeKeyValueStorage();
    const first = mount(round2(), unavailable, { storage });
    first.draft.context.value = "引き継ぎメモ";
    first.draft.setPoint("r1", "要点");
    first.draft.setBody("r1", "書きかけ");
    first.draft.memo.value = "メモ宛て";
    await first.draft.draft("r1");
    first.scope.stop();

    const again = mount(round2(), drafted, { storage });
    expect(again.draft.context.value).toBe("引き継ぎメモ");
    expect(again.draft.point("r1")).toBe("要点");
    expect(again.draft.body("r1")).toBe("書きかけ");
    expect(again.draft.memo.value).toBe("メモ宛て");
    await again.draft.draft("r1");
    expect(sentIds(again.http)).toEqual(["cmd-1"]);
    expect(storage.values.has(PENDING_KEY)).toBe(false);
  });

  it("R3 のやり直しで本文と要点は消え、コンテキストは残る（記録も書き換わる）", async () => {
    const { draft, view, sessionStorage } = mount(round3(1, T0));
    draft.context.value = "引き継ぎメモ";
    draft.setPoint("t1", "要点");
    draft.setBody("t1", "本文");
    view.value = viewIn(round3(2, T0 + 90_000));
    await nextTick();
    expect(draft.point("t1")).toBe("");
    expect(draft.body("t1")).toBe("");
    expect(draft.context.value).toBe("引き継ぎメモ");
    expect(sessionStorage.values.get(DRAFT_KEY)).toContain(String(T0 + 90_000));
  });

  it("壊れた記録は捨てて空で始める", () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(DRAFT_KEY, "{not json");
    storage.values.set(PENDING_KEY, JSON.stringify({ mailId: "zz", commandId: "x" }));
    const { draft } = mount(round2(), drafted, { storage });
    expect(draft.context.value).toBe("");
    expect(storage.values.get(DRAFT_KEY)).toContain('"context":""');
  });

  it("壊れた未確定 ID は捨てて新しい ID で送る", async () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(PENDING_KEY, JSON.stringify({ mailId: "zz", commandId: "x" }));
    const { draft, http } = mount(round2(), drafted, { storage });
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1"]);
  });

  it.each([
    ["503", unavailable],
    [
      "切断",
      (): HttpResponse => {
        throw new Error("offline");
      },
    ],
  ])(
    "保存がブロックされていても、%s の後に同じ内容で押し直すと同じ ID で送る",
    async (_label, answer) => {
      const storage = new FakeKeyValueStorage();
      storage.failing = true;
      const { draft, http } = mount(round2(), answer, { storage });
      draft.setPoint("r1", "要点");
      await draft.draft("r1");
      await draft.draft("r1");
      draft.setPoint("r1", "要点を変えた");
      await draft.draft("r1");
      expect(sentIds(http)).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
    },
  );

  it("保存がブロックされていても、確定した ID はメモリからも捨てる", async () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    let answer: () => HttpResponse = unavailable;
    const { draft, http } = mount(round2(), () => answer(), { storage });
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    answer = drafted;
    await draft.draft("r1");
    await draft.draft("r1");
    expect(sentIds(http)).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
  });

  it("保存がブロックされていても、メモリの書きかけで下書きを送れる", async () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const { draft, http } = mount(round2(), drafted, { storage });
    draft.setPoint("r1", "要点");
    await draft.draft("r1");
    await flush();
    expect(http.requests).toHaveLength(1);
    expect(draft.body("r1")).toBe(DRAFTED);
  });
});
