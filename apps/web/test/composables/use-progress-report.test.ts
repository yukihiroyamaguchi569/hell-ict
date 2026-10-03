import { gameInstantSchema, gameViewResponseSchema } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { createGameApi } from "../../src/api/game-api.js";
import { createGameSession } from "../../src/composables/use-game-session.js";
import type { HttpResponse } from "../../src/ports.js";
import {
  joinReportKind,
  PROGRESS_RETRY_DELAYS_MS,
  progressViewId,
  useProgressReport,
} from "../../src/composables/use-progress-report.js";
import {
  FakeGameServer,
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  unavailable,
  staleGeneration,
  START_MS,
  viewBody,
} from "../fakes.js";

const INSTANT = gameInstantSchema.parse(new Date(START_MS).toISOString());
const BASE = gameViewResponseSchema.parse(viewBody(0)).state;

const inStage = (
  stage: TeamGameViewState["game"]["stage"],
  inbox: TeamGameViewState["inbox"] = null,
): TeamGameViewState => ({ ...BASE, game: { ...BASE.game, stage }, inbox });

describe("progressViewId", () => {
  it("Prologue は受信トレイを開く前後で welcome と inbox に分かれる", () => {
    expect(progressViewId(inStage("prologue"))).toBe("welcome");
    expect(progressViewId(inStage("prologue", { openedAt: START_MS, sent: [] }))).toBe("inbox");
  });

  it("ステージに入った後はステージの id をそのまま使う", () => {
    for (const stage of ["s1", "s2", "s3", "s4", "s5", "s6", "final"] as const) {
      expect(progressViewId(inStage(stage))).toBe(stage);
    }
  });
});

describe("joinReportKind", () => {
  it("Prologue で入れば entry、先へ進んだチームへ戻れば resume", () => {
    expect(joinReportKind("welcome")).toBe("entry");
    expect(joinReportKind("inbox")).toBe("entry");
    for (const view of ["s1", "s3", "s6", "final"] as const) {
      expect(joinReportKind(view)).toBe("resume");
    }
  });
});

const setup = () => {
  const server = new FakeGameServer();
  /** How the Worker answers POST /api/progress. Throwing is a lost connection. */
  let progressAnswer: () => HttpResponse = () => ok({ ok: true });
  const http = new FakeHttp((request) =>
    request.path === "/api/progress" ? progressAnswer() : server.handle(request),
  );
  const reportScheduler = new FakeScheduler();
  const reportResume = new FakeResumeSignal();
  const clock = new FakeClock(new Date(START_MS));
  const teamName = ref("発熱対策室");
  const scope = effectScope();
  const session = scope.run(() => {
    const created = createGameSession({
      api: createGameApi(http),
      clock,
      ids: new FakeIdGenerator(
        Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${String(i)}`),
      ),
      storage: new FakeKeyValueStorage(),
      scheduler: new FakeScheduler(),
      resume: new FakeResumeSignal(),
    });
    useProgressReport({
      http,
      clock,
      scheduler: reportScheduler,
      resume: reportResume,
      session: created,
      teamName,
    });
    return created;
  });
  if (session === undefined) throw new Error("effect scope did not run");
  const reports = () => http.to("/api/progress").map((request) => request.body);
  const answerProgress = (answer: () => HttpResponse): void => {
    progressAnswer = answer;
  };
  return {
    server,
    http,
    session,
    teamName,
    reports,
    scope,
    reportScheduler,
    reportResume,
    answerProgress,
  };
};

describe("useProgressReport", () => {
  it("入室したら1回、モックと同じ形で POST /api/progress を送る", async () => {
    const { session, reports } = setup();
    await session.join("123456");
    await nextTick();
    expect(reports()).toEqual([
      {
        teamCode: "123456",
        teamName: "発熱対策室",
        pos: 0,
        view: "welcome",
        kind: "entry",
        generation: 3,
        clientAt: INSTANT,
      },
    ]);
  });

  it("停留所が動かない応答では送らない", async () => {
    const { session, reports } = setup();
    await session.join("123456");
    await nextTick();
    await session.refresh();
    await nextTick();
    expect(reports()).toHaveLength(1);
  });

  it("停留所が進んでも送らない（クリアと入場は Worker が記録する）", async () => {
    const { session, reports } = setup();
    await session.join("123456");
    await nextTick();
    await session.send({ type: "inbox.open" });
    await nextTick();
    expect(session.view.value?.pos).toBe(1);
    await session.send({ type: "inbox.open" });
    await nextTick();
    await session.refresh();
    await nextTick();
    expect(reports().map((body) => (body as { kind: string }).kind)).toEqual(["entry"]);
  });

  it("先へ進んだチームへ戻ったら、名前付きの resume を1件だけ送る", async () => {
    const { session, reports, http, server } = setup();
    const s3 = { ...viewBody(3), state: { ...BASE, game: { ...BASE.game, stage: "s3" } } };
    http.handler = (request) => {
      if (request.path === "/api/progress") return ok({ ok: true });
      return request.path.endsWith("/game") ? ok(s3) : server.handle(request);
    };
    await session.join("123456");
    await nextTick();
    await session.refresh();
    await nextTick();
    expect(reports()).toEqual([
      expect.objectContaining({ teamName: "発熱対策室", pos: 3, view: "s3", kind: "resume" }),
    ]);
  });

  it("名前は24文字で切って送る", async () => {
    const { session, reports, teamName } = setup();
    teamName.value = "あ".repeat(30);
    await session.join("123456");
    await nextTick();
    expect((reports()[0] as { teamName: string }).teamName).toHaveLength(24);
  });

  it("入室前・古くなった端末からは送らない", async () => {
    const { session, reports, http, server } = setup();
    await nextTick();
    expect(reports()).toEqual([]);
    await session.join("123456");
    await nextTick();
    http.handler = (request) =>
      request.path.endsWith("/commands") ? staleGeneration() : server.handle(request);
    await session.send({ type: "inbox.open" });
    await nextTick();
    expect(session.status.value).toBe("stale");
    expect(reports()).toHaveLength(1);
  });

  it("送信の失敗は握りつぶし、ゲームを止めない", async () => {
    const { session, http, server } = setup();
    http.handler = (request) => {
      if (request.path === "/api/progress") throw new Error("offline");
      return server.handle(request);
    };
    await session.join("123456");
    await nextTick();
    await flush();
    expect(session.status.value).toBe("ready");
    await expect(session.send({ type: "inbox.open" })).resolves.toMatchObject({ kind: "done" });
  });
});

describe("useProgressReport の再送", () => {
  /** Lets an answer settle, then fires every timer that is due by `ms`. */
  const advance = async (scheduler: FakeScheduler, ms: number): Promise<void> => {
    await flush();
    scheduler.advanceBy(ms);
    await flush();
  };

  it("503 なら間を置いて同じ本文で再送し、2xx が返ったらやめる", async () => {
    const { session, reports, reportScheduler, answerProgress } = setup();
    answerProgress(unavailable);
    await session.join("123456");
    await nextTick();
    await flush();
    expect(reports()).toHaveLength(1);
    expect(reportScheduler.delays).toEqual([PROGRESS_RETRY_DELAYS_MS[0]]);

    answerProgress(() => ok({ ok: true }));
    await advance(reportScheduler, PROGRESS_RETRY_DELAYS_MS[0]);
    expect(reports()).toHaveLength(2);
    expect(reports()[1]).toEqual(reports()[0]);
    await advance(reportScheduler, 60_000);
    expect(reports()).toHaveLength(2);
    expect(reportScheduler.pending).toBe(0);
  });

  it("2xx が返ったら再送しない", async () => {
    const { session, reports, reportScheduler, reportResume } = setup();
    await session.join("123456");
    await nextTick();
    await advance(reportScheduler, 60_000);
    reportResume.fire();
    await flush();
    expect(reports()).toHaveLength(1);
    expect(reportScheduler.delays).toEqual([]);
  });

  it("定時の再送は上限回数で止め、あとは復帰のたびに1回ずつ試す（タイマーは積まない）", async () => {
    const { session, reports, reportScheduler, reportResume, answerProgress } = setup();
    answerProgress(() => {
      throw new Error("offline");
    });
    await session.join("123456");
    await nextTick();
    for (const delay of PROGRESS_RETRY_DELAYS_MS) await advance(reportScheduler, delay);
    await advance(reportScheduler, 60_000);
    const afterTimers = 1 + PROGRESS_RETRY_DELAYS_MS.length;
    expect(reports()).toHaveLength(afterTimers);
    expect(reportScheduler.pending).toBe(0);

    // 復帰1回目も失敗。タイマーは積まず、次の復帰を待つ。
    answerProgress(unavailable);
    reportResume.fire();
    await flush();
    expect(reports()).toHaveLength(afterTimers + 1);
    await advance(reportScheduler, 60_000);
    expect(reports()).toHaveLength(afterTimers + 1);
    expect(reportScheduler.pending).toBe(0);

    // サーバが戻った後の復帰2回目で届く。
    answerProgress(() => ok({ ok: true }));
    reportResume.fire();
    await flush();
    expect(reports()).toHaveLength(afterTimers + 2);
    expect(reports().at(-1)).toEqual(reports()[0]);

    // 届いた後の復帰では送らない。
    reportResume.fire();
    await flush();
    expect(reports()).toHaveLength(afterTimers + 2);
  });

  it("破棄した後は、待っていた再送も復帰での再試行も送らない", async () => {
    const { session, reports, reportScheduler, reportResume, answerProgress, scope } = setup();
    answerProgress(unavailable);
    await session.join("123456");
    await nextTick();
    await flush();
    expect(reportScheduler.pending).toBe(1);
    scope.stop();
    expect(reportScheduler.pending).toBe(0);
    expect(reportResume.listeners.size).toBe(0);
    await advance(reportScheduler, 60_000);
    reportResume.fire();
    await flush();
    expect(reports()).toHaveLength(1);
  });
});
