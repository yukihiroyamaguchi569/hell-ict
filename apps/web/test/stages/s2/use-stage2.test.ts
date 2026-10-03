import { stage2SheetRows } from "@hell-ict/content";
import { STAGE2_DEADLINE_MS } from "@hell-ict/domain";
import type { GameCommandResponse, Stage2State } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { GameView, SendOutcome } from "../../../src/composables/use-game-session.js";
import { cellKey } from "../../../src/stages/s2/s2-view.js";
import { STAGE2_START_RETRY_MS, useStage2 } from "../../../src/stages/s2/use-stage2.js";
import { FakeKeyValueStorage } from "../../fakes.js";
import { appliedWith, rejectedWith } from "../s1/fake-session.js";
import { s2Context, s2View, settle, T0 } from "./s2-fixtures.js";

const GRID_KEY = "hellVueGrid:123456";
const DEADLINE = T0 + STAGE2_DEADLINE_MS;
const started: Stage2State = { startedAt: T0, addendumTakenAt: null };
const taken: Stage2State = { startedAt: T0, addendumTakenAt: DEADLINE + 1_000 };
const SHEET = stage2SheetRows.length;

const mount = (...args: Parameters<typeof s2Context>) => {
  const fake = s2Context(...args);
  const scope = effectScope();
  const stage = scope.run(() => useStage2(fake.context));
  if (stage === undefined) throw new Error("the scope did not run");
  return { ...fake, stage, scope };
};

type Judgement = Extract<GameCommandResponse, { status: "applied" }>["judgement"];

const judged = (judgement: Judgement, view: GameView): SendOutcome => ({
  kind: "done",
  response: { status: "applied", events: [], judgement, ...view },
});

describe("useStage2: 入場と s2.start", () => {
  it("まだ始まっていなければ1回だけ送り、始まったら配布版の表を保存する", async () => {
    const { types, stage, storage } = mount(s2View(null), () => appliedWith(s2View(started)));
    await settle();
    expect(types()).toEqual(["s2.start"]);
    expect(stage.grid.value).toHaveLength(SHEET);
    expect(JSON.parse(storage.values.get(GRID_KEY) ?? "null")).toMatchObject({
      startedAt: T0,
      addendumIn: false,
    });
  });

  it("届かなければ少し待って送り直す。ステージを離れたら送り直さない", async () => {
    const first = mount(s2View(null), () => ({ kind: "unavailable" }));
    await settle();
    first.scheduler.advanceBy(STAGE2_START_RETRY_MS);
    await settle();
    expect(first.types()).toEqual(["s2.start", "s2.start"]);

    const second = mount(s2View(null), () => ({ kind: "unavailable" }));
    await settle();
    second.scope.stop();
    second.scheduler.advanceBy(STAGE2_START_RETRY_MS);
    await settle();
    expect(second.types()).toEqual(["s2.start"]);
  });

  it("始まっている・クリア済み・別のステージでは送らない（禁止遷移）", async () => {
    for (const view of [
      s2View(started),
      s2View(null, { cleared: true }),
      {
        ...s2View(null),
        state: {
          ...s2View(null).state,
          game: { ...s2View(null).state.game, stage: "s1" as const },
        },
      },
    ]) {
      const { types } = mount(view);
      await settle();
      expect(types()).toEqual([]);
    }
  });
});

describe("useStage2: グリッドの保存", () => {
  it("編集は保存され、同じ開始の再読み込みで戻る", async () => {
    const storage = new FakeKeyValueStorage();
    const first = mount(s2View(started), undefined, { storage });
    first.stage.edit(1, 0, "001");
    first.stage.deleteRow(0);
    first.scope.stop();

    const again = mount(s2View(started), undefined, { storage });
    await settle();
    expect(again.stage.grid.value).toHaveLength(SHEET - 1);
    expect(again.stage.grid.value[0]?.[0]).toBe("001");
  });

  it("別の開始（GM のリセット後）の保存や壊れた保存は捨てて配布版から", () => {
    for (const saved of [
      JSON.stringify({ startedAt: T0 - 1, grid: [], addendumIn: false }),
      "{not json",
      JSON.stringify({ startedAt: T0, grid: [["1"]], addendumIn: false }),
    ]) {
      const storage = new FakeKeyValueStorage();
      storage.values.set(GRID_KEY, saved);
      const { stage } = mount(s2View(started), undefined, { storage });
      expect(stage.grid.value).toHaveLength(SHEET);
    }
  });

  it("保存できなくても画面の中では編集が効く", () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const { stage } = mount(s2View(started), undefined, { storage });
    stage.addRow();
    expect(stage.grid.value).toHaveLength(SHEET + 1);
  });

  it("［最初の状態に戻す］は配布版に戻し、光を消す", async () => {
    const { stage } = mount(s2View(started), () =>
      judged(
        { outcome: "reject", check: "required-cells", cells: [{ row: 0, column: 1 }] },
        s2View(started),
      ),
    );
    stage.deleteRow(3);
    await stage.submit();
    stage.reopen();
    stage.reset();
    expect(stage.grid.value).toHaveLength(SHEET);
    expect(stage.hot.value.size).toBe(0);
  });
});

describe("useStage2: 締切と追加分", () => {
  it("締切の1ms前は着弾せず、ちょうどで追加分のメールと音が1回", async () => {
    const { stage, serverNow, sounds } = mount(s2View(started), undefined, { now: DEADLINE - 1 });
    await settle();
    expect(stage.canTake.value).toBe(false);
    expect(stage.inboxRows.value).toHaveLength(1);
    serverNow.value = DEADLINE;
    await settle();
    serverNow.value = DEADLINE + 250;
    await settle();
    expect(stage.canTake.value).toBe(true);
    expect(stage.inboxRows.value.map((row) => row.id)).toEqual(["s2-add", "s2-main"]);
    expect(sounds).toEqual(["decision1"]);
  });

  it("再読み込みで既に着弾していれば音は鳴らさない", async () => {
    const { sounds } = mount(s2View(started), undefined, { now: DEADLINE + 30_000 });
    await settle();
    expect(sounds).toEqual([]);
  });

  it("着弾音は締切から999msまでに気づけば鳴り、1000msでは鳴らない（境界）", async () => {
    const late = mount(s2View(started), undefined, { now: DEADLINE + 999 });
    await settle();
    expect(late.sounds).toEqual(["decision1"]);
    const tooLate = mount(s2View(started), undefined, { now: DEADLINE + 1_000 });
    await settle();
    expect(tooLate.sounds).toEqual([]);
  });

  it("［表に追加］が届かなければ10行を足さず、押し直せる", async () => {
    const answers: SendOutcome[] = [{ kind: "unavailable" }, appliedWith(s2View(taken))];
    const { stage, sent } = mount(s2View(started), () => answers.shift() ?? { kind: "failed" }, {
      now: DEADLINE + 2_000,
    });
    await stage.take();
    await settle();
    expect(stage.grid.value).toHaveLength(SHEET);
    expect(stage.canTake.value).toBe(true);
    await stage.take();
    await settle();
    expect(sent).toEqual([{ type: "s2.take-addendum" }, { type: "s2.take-addendum" }]);
    expect(stage.grid.value).toHaveLength(SHEET + 10);
  });

  it("着弾前の［表に追加］は送らない（禁止遷移）", async () => {
    const { stage, sent } = mount(s2View(started));
    await stage.take();
    expect(sent).toEqual([]);
  });

  it("取り込むと10行が1回だけ末尾に付き、再読み込みでも増えない", async () => {
    const storage = new FakeKeyValueStorage();
    const { stage, sent, view } = mount(s2View(started), () => appliedWith(s2View(taken)), {
      now: DEADLINE + 2_000,
      storage,
    });
    await stage.take();
    await settle();
    expect(sent).toEqual([{ type: "s2.take-addendum" }]);
    expect(stage.grid.value).toHaveLength(SHEET + 10);
    view.value = s2View(taken);
    await settle();
    expect(stage.grid.value).toHaveLength(SHEET + 10);
    expect(stage.canTake.value).toBe(false);

    const again = mount(s2View(taken), undefined, { now: DEADLINE + 3_000, storage });
    expect(again.stage.grid.value).toHaveLength(SHEET + 10);
  });

  it("保存が無いまま取り込み済みなら、配布版＋追加分から始める", () => {
    const { stage } = mount(s2View(taken), undefined, { now: DEADLINE + 3_000 });
    expect(stage.grid.value).toHaveLength(SHEET + 10);
  });
});

describe("useStage2: 提出", () => {
  const reject = judged(
    { outcome: "reject", check: "collection-date", cells: [{ row: 2, column: 2 }] },
    s2View(started),
  );

  it("差し戻しは判定の文言・光るセル・cancel の音。直したセルは光が消え、［提出に戻る］で開く", async () => {
    const { stage, sounds, sent } = mount(s2View(started), () => reject);
    const pending = stage.submit();
    expect(stage.verdict.value).toEqual({ kind: "checking" });
    await pending;
    expect(sent[0]).toMatchObject({ type: "s2.submit" });
    expect(stage.verdict.value?.kind).toBe("rejected");
    expect([...stage.hot.value]).toEqual([cellKey(2, 2)]);
    expect(sounds).toEqual(["cancel"]);
    stage.edit(2, 2, "2026-07-03");
    expect(stage.hot.value.size).toBe(0);
    stage.reopen();
    expect(stage.verdict.value).toBeNull();
  });

  it("送り直しが duplicate で返っても、最初の判定（差し戻しの理由と光るセル）で読む", async () => {
    const { stage, sounds } = mount(s2View(started), () => ({
      kind: "done",
      response: {
        status: "duplicate",
        original: {
          events: [],
          judgement: {
            outcome: "reject",
            check: "collection-date",
            cells: [{ row: 2, column: 2 }],
          },
        },
        ...s2View(started),
      },
    }));
    await stage.submit();
    const verdict = stage.verdict.value;
    expect(verdict?.kind === "rejected" && verdict.lines[1]).toBe(
      "✗ 採取日が YYYY-MM-DD に統一　→ 1件が YYYY-MM-DD になっていません",
    );
    expect([...stage.hot.value]).toEqual([cellKey(2, 2)]);
    expect(sounds).toEqual(["cancel"]);
  });

  it("判定を待つ間の2回目の提出は送らない", async () => {
    let release: (outcome: SendOutcome) => void = () => undefined;
    const { stage, sent } = mount(
      s2View(started),
      () =>
        new Promise<SendOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const first = stage.submit();
    await stage.submit();
    release(reject);
    await first;
    expect(sent).toHaveLength(1);
  });

  it("届かなかったら音も光も無く、もう一度提出を促す", async () => {
    const { stage, sounds } = mount(s2View(started), () => ({ kind: "unavailable" }));
    await stage.submit();
    expect(stage.verdict.value).toEqual({
      kind: "rejected",
      lines: ["提出を届けられませんでした。もう一度提出してください。"],
    });
    expect(sounds).toEqual([]);
    expect(stage.hot.value.size).toBe(0);
  });

  it("合格はクリアの一行で、［提出に戻る］では開かない。クリア後は送らない", async () => {
    const { stage, sent } = mount(s2View(started), () =>
      judged({ outcome: "pass" }, s2View(started, { cleared: true })),
    );
    await stage.submit();
    expect(stage.verdict.value).toEqual({ kind: "cleared", text: "Stage 2 をクリアしました" });
    stage.reopen();
    expect(stage.verdict.value?.kind).toBe("cleared");
    await stage.submit();
    expect(sent).toHaveLength(1);
  });

  it("断られた（already-cleared）ときも差し戻し音は鳴らさない", async () => {
    const { stage, sounds } = mount(s2View(started), () =>
      rejectedWith("already-cleared", s2View(started, { cleared: true })),
    );
    await stage.submit();
    expect(sounds).toEqual([]);
  });
});

describe("useStage2: 表を流し込む（［表に送る］と複数行の貼り付け）", () => {
  const TABLE =
    "患者ID\t病棟\t採取日\tMRSA結果\t発熱\t備考\n001\t5A\t2026-07-01\t陽性\tあり\t\n2\t5A";

  it("読める表は見出しを落として即座に置き換え、保存し、光を消して着弾を数える", async () => {
    const { stage, storage } = mount(s2View(started));
    await settle();
    stage.edit(0, 0, "x");
    stage.sendTable(TABLE);
    expect(stage.grid.value).toEqual([
      ["001", "5A", "2026-07-01", "陽性", "あり", ""],
      ["2", "5A", "", "", "", ""],
    ]);
    expect(stage.pasteError.value).toBeNull();
    expect(stage.landed.value).toBe(1);
    expect(JSON.parse(storage.values.get(GRID_KEY) ?? "null")).toMatchObject({
      grid: stage.grid.value,
    });
  });

  it("形が崩れた表は理由を出し、グリッドも保存も変えない。次に表が入れば理由は消える", async () => {
    const { stage, storage } = mount(s2View(started));
    await settle();
    const before = stage.grid.value;
    const saved = storage.values.get(GRID_KEY);
    for (const [text, why] of [
      ['a,"b\nc,d', "引用符が閉じていません"],
      ["1\t2\t3\t4\t5\t6\t7\n1\t2", "列が6つを超えています（1行目）"],
      ["区切りの無い\n二行", "表として読めません（タブ・カンマ・|の区切りが必要です）。"],
      ["一行だけ", "表として読めません（タブ・カンマ・|の区切りが必要です）。"],
    ] as const) {
      stage.sendTable(text);
      expect(stage.pasteError.value).toContain(why);
      expect(stage.grid.value).toBe(before);
    }
    expect(storage.values.get(GRID_KEY)).toBe(saved);
    expect(stage.landed.value).toBe(0);
    stage.sendTable(TABLE);
    expect(stage.pasteError.value).toBeNull();
  });

  it("差し戻しの判定が出ていれば表を開き直す。判定待ち・クリア後は流し込まない（禁止遷移）", async () => {
    const rejected = mount(s2View(started), () =>
      judged(
        { outcome: "reject", check: "collection-date", cells: [{ row: 2, column: 2 }] },
        s2View(started),
      ),
    );
    await rejected.stage.submit();
    rejected.stage.sendTable(TABLE);
    expect(rejected.stage.verdict.value).toBeNull();
    expect(rejected.stage.hot.value.size).toBe(0);

    let release: (outcome: SendOutcome) => void = () => undefined;
    const checking = mount(
      s2View(started),
      () =>
        new Promise<SendOutcome>((resolve) => {
          release = resolve;
        }),
    );
    await settle();
    const pending = checking.stage.submit();
    checking.stage.sendTable(TABLE);
    expect(checking.stage.grid.value).toHaveLength(SHEET);
    release({ kind: "unavailable" });
    await pending;

    const cleared = mount(s2View(started, { cleared: true }));
    await settle();
    cleared.stage.sendTable(TABLE);
    expect(cleared.stage.landed.value).toBe(0);
  });
});
