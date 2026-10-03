import {
  stage4ActionRejects,
  stage4DirectorMail,
  stage4Labels,
  stage4SendFailed,
  stage4SummaryReject,
} from "@hell-ict/content";
import { stage4Answers } from "@hell-ict/content/answers";
import { judgeStage4Action, judgeStage4Summary } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { createGameApi } from "../../../src/api/game-api.js";
import { createGameSession } from "../../../src/composables/use-game-session.js";
import type { HttpRequest, HttpResponse } from "../../../src/ports.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import {
  DIRECTOR_DELAY_MS,
  DIRECTOR_PAGE_GRACE_MS,
  STAGE4_ROWS,
  TALK_DELAY_MS,
} from "../../../src/stages/s4/s4-view.js";
import { useStage4 } from "../../../src/stages/s4/use-stage4.js";
import type { StageContext } from "../../../src/stages/stage-module.js";
import {
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  START_MS,
  viewBody,
} from "../../fakes.js";

const ENTERED_MS = START_MS + 60_000;
const ENTERED = new Date(ENTERED_MS).toISOString();
const RECORD_KEY = "hellVueS4:123456";
const SUMMARY_OK = stage4Answers.summaryOk;
const ACTION_OK = stage4Answers.actionOk;

const ids = Array.from(
  { length: 40 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);

/** A Worker for a team in Stage 4, judging with the domain's own judges. */
class Stage4Server {
  accepted = false;
  cleared = false;
  readonly commands: Record<string, unknown>[] = [];
  /** Replaces the answer to the next commands (a lost connection throws). */
  override: ((body: Record<string, unknown>) => HttpResponse) | null = null;

  view() {
    const base = viewBody(5);
    return {
      ...base,
      state: {
        ...base.state,
        game: {
          ...base.state.game,
          stage: "s4",
          clearedAt: this.cleared ? { s4: new Date(START_MS + 120_000).toISOString() } : {},
        },
        enteredAt: { s4: ENTERED },
        s4: { summaryAccepted: this.accepted },
      },
    };
  }

  handle = (request: HttpRequest): HttpResponse => {
    if (request.path === "/api/session") return ok(sessionBody("123456", 1));
    if (request.path.endsWith("/game")) return ok(this.view());
    const body =
      typeof request.body === "object" && request.body !== null ? { ...request.body } : {};
    this.commands.push(body);
    if (this.override !== null) return this.override(body);
    return this.judge(body);
  };

  private judge(body: Record<string, unknown>): HttpResponse {
    const text = String(body.text);
    if (body.type === "s4.submit-summary") {
      const judgement = judgeStage4Summary(text);
      if (judgement.outcome === "reject") {
        return ok({ status: "rejected", reason: judgement.reason, judgement, ...this.view() });
      }
      this.accepted = true;
      return ok({ status: "applied", events: [], judgement, ...this.view() });
    }
    if (!this.accepted) {
      return ok({ status: "rejected", reason: "summary-first", judgement: null, ...this.view() });
    }
    const judgement = judgeStage4Action(text);
    if (judgement.outcome === "pass") this.cleared = true;
    return ok({ status: "applied", events: [], judgement, ...this.view() });
  }
}

const setup = async (prepare: (server: Stage4Server, storage: FakeKeyValueStorage) => void) => {
  const server = new Stage4Server();
  const storage = new FakeKeyValueStorage();
  prepare(server, storage);
  const scheduler = new FakeScheduler();
  const played: string[] = [];
  const serverNow = ref(ENTERED_MS);
  const session = createGameSession({
    api: createGameApi(new FakeHttp(server.handle)),
    clock: new FakeClock(new Date(START_MS)),
    ids: new FakeIdGenerator(ids),
    storage: new FakeKeyValueStorage(),
    scheduler,
    resume: new FakeResumeSignal(),
  });
  await session.join("123456");
  const context: StageContext = {
    session,
    serverNow,
    sessionStorage: storage,
    scheduler,
    mail: useMailSelection(),
    sfx: { play: (name) => played.push(name) },
    karubeRead: ref(new Set<string>()),
    teamName: ref(""),
  };
  const scope = effectScope();
  const s4 = scope.run(() => useStage4(context));
  if (s4 === undefined) throw new Error("the scope did not run");
  const settle = async (): Promise<void> => {
    await flush();
    await nextTick();
  };
  return { server, storage, scheduler, played, serverNow, s4, scope, settle };
};

const noop = (): void => undefined;

describe("院長の窓", () => {
  it("入場から2600ms後に開く。各ページは開いて400ms未満の押下を無視し、400msちょうどで進む", async () => {
    const { s4, serverNow, scheduler, storage, settle } = await setup(noop);
    expect(s4.director.visible.value).toBe(false);
    serverNow.value = ENTERED_MS + DIRECTOR_DELAY_MS - 1;
    await settle();
    expect(s4.director.visible.value).toBe(false);
    serverNow.value = ENTERED_MS + DIRECTOR_DELAY_MS;
    await settle();
    expect(s4.director.visible.value).toBe(true);
    expect(s4.director.page.value).toBe(0);

    scheduler.advanceBy(DIRECTOR_PAGE_GRACE_MS - 1);
    s4.director.press();
    expect(s4.director.page.value).toBe(0);
    scheduler.advanceBy(1);
    s4.director.press();
    expect(s4.director.page.value).toBe(1);
    // 2ページ目も開き直した直後の連打は捨てる（1ページ目のダブルクリックで閉じない）。
    s4.director.press();
    expect(s4.director.visible.value).toBe(true);
    scheduler.advanceBy(DIRECTOR_PAGE_GRACE_MS);
    s4.director.press();
    expect(s4.director.visible.value).toBe(false);
    await settle();
    expect(JSON.parse(storage.getItem(RECORD_KEY) ?? "{}")).toMatchObject({
      enteredAt: ENTERED,
      directorClosed: true,
    });
  });

  it("読み終えた窓は再読み込みで出さない。要約の受理後も出さない", async () => {
    const closed = await setup((_, storage) => {
      storage.setItem(
        RECORD_KEY,
        JSON.stringify({ enteredAt: ENTERED, summary: "", directorClosed: true }),
      );
    });
    closed.serverNow.value = ENTERED_MS + 60_000;
    await closed.settle();
    expect(closed.s4.director.visible.value).toBe(false);

    const accepted = await setup((server) => {
      server.accepted = true;
    });
    accepted.serverNow.value = ENTERED_MS + 60_000;
    await accepted.settle();
    expect(accepted.s4.director.visible.value).toBe(false);
  });
});

describe("要約", () => {
  it("先行症状の無い要約は差し戻し（警告色・cancel）、直して出すと受理され700ms後に一往復が出る", async () => {
    const { s4, server, scheduler, played, settle } = await setup(noop);
    s4.summary.value = stage4Answers.summaryNg;
    s4.submitSummary();
    expect(s4.summaryVerdict.value).toEqual({ kind: "checking" });
    await settle();
    expect(s4.summaryVerdict.value).toEqual({ kind: "rejected", lines: [stage4SummaryReject] });
    expect(s4.summaryWarn.value).toBe(true);
    expect(played).toEqual(["cancel"]);

    s4.summary.value = SUMMARY_OK;
    s4.submitSummary();
    await settle();
    expect(s4.summaryAccepted.value).toBe(true);
    expect(s4.summaryWarn.value).toBe(false);
    expect(s4.summaryVerdict.value).toEqual({ kind: "cleared", text: stage4Labels.summarySent });
    expect(s4.talkShown.value).toBe(false);
    scheduler.advanceBy(TALK_DELAY_MS);
    expect(s4.talkShown.value).toBe(true);
    // 受理後はもう送らない。
    s4.submitSummary();
    await settle();
    expect(server.commands.map((c) => c.type)).toEqual(["s4.submit-summary", "s4.submit-summary"]);
  });

  it("本文は sessionStorage に残り、再読み込みで戻る。別の入場の記録は捨てる", async () => {
    const first = await setup(noop);
    first.s4.summary.value = "書きかけ";
    await first.settle();
    const kept = await setup((_, storage) => {
      storage.values.set(RECORD_KEY, first.storage.getItem(RECORD_KEY) ?? "");
    });
    expect(kept.s4.summary.value).toBe("書きかけ");

    const other = await setup((_, storage) => {
      storage.setItem(
        RECORD_KEY,
        JSON.stringify({
          enteredAt: "2026-01-01T00:00:00.000Z",
          summary: "前回",
          directorClosed: true,
        }),
      );
    });
    expect(other.s4.summary.value).toBe("");
  });

  it("壊れた保存は捨てて空から始める。保存できなくても書ける", async () => {
    const broken = await setup((_, storage) => {
      storage.setItem(RECORD_KEY, "{not json");
    });
    expect(broken.s4.summary.value).toBe("");
    expect(broken.storage.getItem(RECORD_KEY)).toBeNull();

    // JSON としては読めるが形が違う（summary が数値）。これも捨てて、窓も読み終えていない扱い。
    const misshapen = await setup((_, storage) => {
      storage.setItem(
        RECORD_KEY,
        JSON.stringify({ enteredAt: ENTERED, summary: 42, directorClosed: true }),
      );
    });
    expect(misshapen.s4.summary.value).toBe("");
    expect(misshapen.storage.getItem(RECORD_KEY)).toBeNull();
    misshapen.serverNow.value = ENTERED_MS + DIRECTOR_DELAY_MS;
    await misshapen.settle();
    expect(misshapen.s4.director.visible.value).toBe(true);

    const blocked = await setup((_, storage) => {
      storage.failing = true;
    });
    blocked.s4.summary.value = "メモリだけ";
    await blocked.settle();
    expect(blocked.s4.summary.value).toBe("メモリだけ");
  });

  it("再読み込みで受理済みなら、一往復をすぐ戻す", async () => {
    const { s4 } = await setup((server) => {
      server.accepted = true;
    });
    expect(s4.talkShown.value).toBe(true);
    expect(s4.summaryVerdict.value).toEqual({ kind: "cleared", text: stage4Labels.summarySent });
  });

  it("送信中の押し直しは送らない。届いたか分からなければ同じ commandId で送り直す", async () => {
    const { s4, server, settle } = await setup(noop);
    server.override = () => ({ status: 400, body: { message: "読めません。" } });
    s4.summary.value = SUMMARY_OK;
    s4.submitSummary();
    s4.submitSummary();
    await settle();
    expect(server.commands).toHaveLength(1);
    expect(s4.summaryVerdict.value).toEqual({ kind: "rejected", lines: [stage4SendFailed] });
    expect(s4.summaryWarn.value).toBe(false);
    expect(s4.summaryAccepted.value).toBe(false);

    server.override = null;
    s4.submitSummary();
    await settle();
    expect(server.commands).toHaveLength(2);
    expect(server.commands[1]?.commandId).toBe(server.commands[0]?.commandId);
    expect(s4.summaryAccepted.value).toBe(true);
  });
});

describe("行動提案", () => {
  it("要約の受理前は送れない", async () => {
    const { s4, server, settle } = await setup(noop);
    s4.action.value = ACTION_OK;
    s4.submitAction();
    await settle();
    expect(server.commands).toEqual([]);
    expect(s4.actionVerdict.value).toBeNull();
  });

  it.each([
    [stage4Answers.actionAimedAtPatients, "aimed-at-patients"],
    [stage4Answers.actionMissingWhat, "missing-what"],
    [stage4Answers.actionMissingWhom, "missing-whom"],
    [stage4Answers.actionMissingBoth, "missing-both"],
  ] as const)("「%s」は %s の文言で差し戻す", async (text, reason) => {
    const { s4, played, settle } = await setup((server) => {
      server.accepted = true;
    });
    s4.action.value = text;
    s4.submitAction();
    await settle();
    expect(s4.actionVerdict.value).toEqual({
      kind: "rejected",
      lines: [stage4ActionRejects[reason]],
    });
    expect(s4.actionWarn.value).toBe(true);
    expect(played).toEqual(["cancel"]);
    expect(s4.cleared.value).toBe(false);
  });

  it("通ればクリア。判定表示は出さず、以後は送らない", async () => {
    const { s4, server, settle } = await setup((server) => {
      server.accepted = true;
    });
    s4.action.value = ACTION_OK;
    s4.submitAction();
    await settle();
    expect(s4.cleared.value).toBe(true);
    expect(s4.actionVerdict.value).toBeNull();
    s4.submitAction();
    await settle();
    expect(server.commands).toHaveLength(1);
  });
});

describe("受信トレイ", () => {
  it("院長室の1通だけ。押すと速報論文をビューアで開く", () => {
    expect(STAGE4_ROWS).toEqual([
      {
        id: "s4-director",
        from: "院長室",
        subject: "周辺国の速報論文",
        attach: stage4DirectorMail.attach,
        opens: { kind: "viewer", doc: "s4report" },
      },
    ]);
  });
});
