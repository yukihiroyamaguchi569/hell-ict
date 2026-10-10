import {
  applyTeamGameCommand,
  gameInstantSchema,
  inboxSettleAt,
  initialTeamGameState,
  teamGameCommandSchema,
  teamGamePosition,
} from "@hell-ict/domain";
import type { TeamGameCommand, TeamGameState } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";

import { createGameApi } from "../../../src/api/game-api.js";
import { createGameSession } from "../../../src/composables/use-game-session.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import type { HttpRequest, HttpResponse } from "../../../src/ports.js";
import {
  ADVANCE_RETRY_MS,
  EMPTY_NOTICE_MS,
  INBOX_SETTLE_MAX_TRIES,
  INBOX_SETTLE_RETRY_MS,
  usePrologue,
} from "../../../src/stages/prologue/use-prologue.js";
import {
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  START_MS,
} from "../../fakes.js";

const CODE = "123456";
const DRAFT_KEY = `hellVueInbox:${CODE}`;
const IDS = Array.from(
  { length: 40 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);
const instant = (ms: number) => gameInstantSchema.parse(new Date(ms).toISOString());

/** The Worker's game API over the real domain rules, on a clock the test moves. */
class PrologueServer {
  state: TeamGameState = initialTeamGameState(instant(START_MS));
  nowMs = START_MS;
  readonly commands: TeamGameCommand[] = [];
  readonly seen = new Set<string>();
  /** Answers to `advance` lost after it was applied (a dropped connection). */
  loseAdvanceAnswers = 0;
  /** The next `inbox.reply` is taken in only once this settles (a slow network). */
  holdNextReply: Promise<void> | null = null;

  respond = (request: HttpRequest): HttpResponse | Promise<HttpResponse> => {
    const held = this.holdNextReply;
    if (
      held === null ||
      teamGameCommandSchema.safeParse(request.body).data?.type !== "inbox.reply"
    ) {
      return this.handle(request);
    }
    this.holdNextReply = null;
    return held.then(() => this.handle(request));
  };

  handle = (request: HttpRequest): HttpResponse => {
    if (request.path === "/api/session") return ok(sessionBody(CODE, 1));
    if (request.path.endsWith("/game")) return ok(this.view());
    const command = teamGameCommandSchema.parse(request.body);
    this.commands.push(command);
    const response = this.apply(command);
    if (command.type === "advance" && this.loseAdvanceAnswers > 0) {
      this.loseAdvanceAnswers -= 1;
      throw new Error("connection lost");
    }
    return ok(response);
  };

  sent(type: TeamGameCommand["type"]): TeamGameCommand[] {
    return this.commands.filter((command) => command.type === type);
  }

  private apply(command: TeamGameCommand) {
    if (this.seen.has(command.commandId)) {
      return { status: "duplicate", original: { events: [], judgement: null }, ...this.view() };
    }
    const result = applyTeamGameCommand(this.state, command, {
      ms: this.nowMs,
      at: instant(this.nowMs),
    });
    if (result.status === "rejected") {
      return { status: "rejected", reason: result.reason, judgement: null, ...this.view() };
    }
    this.seen.add(command.commandId);
    this.state = result.state;
    return { status: "applied", events: result.events, judgement: null, ...this.view() };
  }

  private view() {
    const { game, ...rest } = this.state;
    const { processedCommandIds, ...shown } = game;
    void processedCommandIds;
    const state = { ...rest, game: shown };
    return {
      state,
      pos: teamGamePosition(this.state),
      serverNow: this.nowMs,
      ai: { status: "none" },
    };
  }
}

const start = async (opened = true, storage = new FakeKeyValueStorage()) => {
  const server = new PrologueServer();
  const scheduler = new FakeScheduler();
  const session = createGameSession({
    api: createGameApi(new FakeHttp(server.respond)),
    clock: new FakeClock(new Date(START_MS)),
    ids: new FakeIdGenerator(IDS),
    storage: new FakeKeyValueStorage(),
    scheduler,
    resume: new FakeResumeSignal(),
  });
  if (opened) server.state = { ...server.state, inbox: { openedAt: START_MS, sent: [] } };
  await session.join(CODE);
  const serverNow = ref(START_MS);
  const mail = useMailSelection();
  const context = {
    ...{ session, serverNow, sessionStorage: storage, scheduler, mail },
    ...{
      sfx: { play: () => undefined, tone: () => undefined },
      karubeRead: ref(new Set<string>()),
      chatPiiBlocks: ref(0),
      teamName: ref(""),
    },
  };
  const scope = effectScope();
  const prologue = scope.run(() => usePrologue(context));
  if (prologue === undefined) throw new Error("the scope did not run");
  /** Moves both clocks: the screen's estimate and the server's. */
  const at = async (ms: number, serverMs = ms) => {
    server.nowMs = serverMs;
    serverNow.value = ms;
    await flush();
  };
  return { server, scheduler, storage, session, mail, prologue, scope, at };
};

const SETTLE_AT = inboxSettleAt({ openedAt: START_MS, sent: [] });

/** Holds the next `inbox.reply` until the returned function is called. */
const holdNextReply = (server: PrologueServer): (() => void) => {
  let release: () => void = () => undefined;
  server.holdNextReply = new Promise((resolve) => {
    release = resolve;
  });
  return release;
};

describe("usePrologue: 返信", () => {
  it("開いたメールに返信すると inbox.reply を送り、中央を閉じて書きかけを消す", async () => {
    const { server, mail, prologue } = await start();
    mail.open("p1");
    expect(prologue.openMail.value).toBe("p1");
    prologue.setDraft("p1", "承知しました");
    expect(await prologue.reply("p1")).toBe("done");
    expect(server.sent("inbox.reply")).toMatchObject([{ mailId: "p1", text: "承知しました" }]);
    expect(mail.openId.value).toBeNull();
    expect(prologue.draft("p1")).toBe("");
    expect(prologue.rows.value.find((row) => row.id === "p1")?.closed).toBe(true);
  });

  it("空欄なら送らず、ボタンの文言を 1600ms だけ差し替える（押し直すとそこから数え直す）", async () => {
    const { server, scheduler, mail, prologue } = await start();
    mail.open("p0");
    prologue.setDraft("p0", "  \n ");
    expect(await prologue.reply("p0")).toBe("empty");
    scheduler.advanceBy(1_000);
    await prologue.reply("p0");
    scheduler.advanceBy(EMPTY_NOTICE_MS - 1);
    expect(prologue.emptyShown.value).toBe(true);
    scheduler.advanceBy(1);
    expect(prologue.emptyShown.value).toBe(false);
    expect(server.commands).toEqual([]);
  });

  it("締切を過ぎたメール・返信済みのメールには送らない", async () => {
    const { server, mail, prologue, at } = await start();
    prologue.setDraft("p0", "はい");
    await prologue.reply("p0");
    prologue.setDraft("p0", "もう一度");
    expect(await prologue.reply("p0")).toBe("closed");
    mail.open("p2");
    prologue.setDraft("p2", "はい");
    await at(SETTLE_AT, START_MS);
    expect(prologue.openMail.value).toBeNull();
    expect(mail.openId.value).toBeNull();
    expect(await prologue.reply("p2")).toBe("closed");
    expect(server.sent("inbox.reply")).toHaveLength(1);
  });
});

describe("usePrologue: 返信の応答待ち", () => {
  it("p0 の応答待ちの間も p1 は送れる状態で、p0 の応答が返っても開いている p1 は閉じない", async () => {
    const { server, mail, prologue } = await start();
    const release = holdNextReply(server);
    mail.open("p0");
    prologue.setDraft("p0", "はい");
    const first = prologue.reply("p0");
    await flush();
    mail.open("p1");
    prologue.setDraft("p1", "承知しました");
    expect(prologue.busy("p0")).toBe(true);
    expect(prologue.busy("p1")).toBe(false);
    release();
    expect(await first).toBe("done");
    await flush();
    expect(prologue.busy("p0")).toBe(false);
    expect(mail.openId.value).toBe("p1");
    expect(prologue.openMail.value).toBe("p1");
    expect(prologue.draft("p1")).toBe("承知しました");
    expect(prologue.draft("p0")).toBe("");
    expect(await prologue.reply("p1")).toBe("done");
    expect(server.sent("inbox.reply")).toMatchObject([{ mailId: "p0" }, { mailId: "p1" }]);
  });

  it("p0 の応答待ちの間に押した p1 の返信も送られ、両方とも返信済みになる", async () => {
    const { server, mail, prologue } = await start();
    const release = holdNextReply(server);
    prologue.setDraft("p0", "はい");
    const first = prologue.reply("p0");
    await flush();
    mail.open("p1");
    prologue.setDraft("p1", "承知しました");
    const second = prologue.reply("p1");
    expect(prologue.busy("p1")).toBe(true);
    release();
    expect([await first, await second]).toEqual(["done", "done"]);
    await flush();
    expect(mail.openId.value).toBeNull();
    const closed = prologue.rows.value.filter((row) => row.closed).map((row) => row.id);
    expect(closed).toEqual(["p0", "p1"]);
  });

  it("送信が例外で終わっても送信中は解け、同じメールをもう一度送れる", async () => {
    const { server, session, mail, prologue } = await start();
    vi.spyOn(session, "send").mockRejectedValueOnce(new Error("boom"));
    mail.open("p0");
    prologue.setDraft("p0", "はい");
    await expect(prologue.reply("p0")).rejects.toThrow("boom");
    expect(prologue.busy("p0")).toBe(false);
    expect(prologue.draft("p0")).toBe("はい");
    expect(await prologue.reply("p0")).toBe("done");
    expect(server.sent("inbox.reply")).toMatchObject([{ mailId: "p0", text: "はい" }]);
  });

  it("同じメールの応答待ちの間は、そのメールを二重に送らない", async () => {
    const { server, mail, prologue } = await start();
    const release = holdNextReply(server);
    mail.open("p0");
    prologue.setDraft("p0", "はい");
    const first = prologue.reply("p0");
    await flush();
    expect(await prologue.reply("p0")).toBe("closed");
    release();
    expect(await first).toBe("done");
    expect(server.sent("inbox.reply")).toHaveLength(1);
    expect(prologue.busy("p0")).toBe(false);
  });
});

describe("usePrologue: 書きかけ（hellVueInbox:<code>）", () => {
  it("同じ受信トレイなら再読み込みで戻り、別の openedAt の保存は拾わない", async () => {
    const storage = new FakeKeyValueStorage();
    const first = await start(true, storage);
    first.prologue.setDraft("p2", "書きかけ");
    first.scope.stop();
    expect((await start(true, storage)).prologue.draft("p2")).toBe("書きかけ");
    storage.setItem(DRAFT_KEY, JSON.stringify({ openedAt: START_MS - 1, drafts: { p2: "前の" } }));
    expect((await start(true, storage)).prologue.draft("p2")).toBe("");
  });

  it("壊れた保存は捨て、保存できない環境でもメモリで書きかけを持つ", async () => {
    const storage = new FakeKeyValueStorage();
    storage.setItem(DRAFT_KEY, "{not json");
    const { prologue } = await start(true, storage);
    expect(prologue.draft("p0")).toBe("");
    expect(storage.getItem(DRAFT_KEY)).toBeNull();
    storage.failing = true;
    prologue.setDraft("p0", "メモリだけ");
    expect(prologue.draft("p0")).toBe("メモリだけ");
  });
});

describe("usePrologue: 締切の inbox.settle とクリア後の advance", () => {
  it("締切ちょうどで settle を1回だけ送り、クリアしたら advance {prologue→s1} を1回送る", async () => {
    const { server, session, at } = await start();
    await at(SETTLE_AT - 1);
    expect(server.sent("inbox.settle")).toEqual([]);
    await at(SETTLE_AT);
    await at(SETTLE_AT + 250);
    await at(SETTLE_AT + 500);
    expect(server.sent("inbox.settle")).toHaveLength(1);
    expect(server.sent("advance")).toMatchObject([{ from: "prologue", to: "s1" }]);
    expect(session.view.value?.state.game.stage).toBe("s1");
  });

  it("画面の推定が早すぎて拒否されたら 1秒後に聞き直す（上限10回）", async () => {
    const { server, scheduler, session, at } = await start();
    await at(SETTLE_AT, SETTLE_AT - 500);
    expect(server.sent("inbox.settle")).toHaveLength(1);
    scheduler.advanceBy(INBOX_SETTLE_RETRY_MS);
    await flush();
    expect(server.sent("inbox.settle")).toHaveLength(2);
    for (let i = 0; i < 20; i += 1) {
      scheduler.advanceBy(INBOX_SETTLE_RETRY_MS);
      await flush();
    }
    expect(server.sent("inbox.settle")).toHaveLength(INBOX_SETTLE_MAX_TRIES);
    expect(server.sent("advance")).toEqual([]);
    expect(session.view.value?.state.game.stage).toBe("prologue");
  });

  it("3通返せば最後の返信でクリアし、settle は送らない", async () => {
    const { server, prologue, at } = await start();
    for (const id of ["p0", "p1", "p2"] as const) {
      prologue.setDraft(id, "はい");
      await prologue.reply(id);
    }
    await flush();
    await at(SETTLE_AT + 1_000);
    expect(server.sent("advance")).toHaveLength(1);
    expect(server.sent("inbox.settle")).toEqual([]);
  });

  it("advance の応答が届かなければ同じ commandId で送り直し、二重に適用しない", async () => {
    const { server, scheduler, session, prologue } = await start();
    prologue.setDraft("p0", "はい");
    await prologue.reply("p0");
    prologue.setDraft("p1", "はい");
    await prologue.reply("p1");
    prologue.setDraft("p2", "はい");
    // Every delivery of the first advance is applied or found a duplicate, and its answer lost.
    server.loseAdvanceAnswers = 5;
    await prologue.reply("p2");
    for (let i = 0; i < 12; i += 1) {
      scheduler.advanceBy(ADVANCE_RETRY_MS);
      await flush();
    }
    const advances = server.sent("advance");
    expect(advances.length).toBeGreaterThan(5);
    expect(new Set(advances.map((command) => command.commandId)).size).toBe(1);
    expect(server.state.enteredAt.s1).toBeDefined();
    expect(session.view.value?.state.game.stage).toBe("s1");
  });

  it("受信トレイを開く前（welcome）と Stage 1 以降は何も送らない。離れたら予約を残さない", async () => {
    const { server, scheduler, prologue, scope, at } = await start(false);
    expect(prologue.rows.value).toEqual([]);
    await at(SETTLE_AT + 10_000);
    expect(server.commands).toEqual([]);
    await prologue.reply("p0");
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
