import {
  chatSendNotices,
  stage6CopyReject,
  stage6CopyRejectDelayMs,
  stage6GenerateBusy,
  stage6GenerateMs,
  stage6JimuMail,
  stage6Labels,
  stage6RejectType,
  stage6SendFailed,
} from "@hell-ict/content";
import { stage6Answers } from "@hell-ict/content/answers";
import {
  CHAT_MESSAGE_MAX_CHARS,
  isS6PromptCopiedFromMail,
  judgeS6Submission,
  redactPii,
  selectS6PosterType,
} from "@hell-ict/domain";
import type { S6PosterType } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { createGameApi } from "../../../src/api/game-api.js";
import { createGameSession } from "../../../src/composables/use-game-session.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import type { HttpRequest, HttpResponse } from "../../../src/ports.js";
import { posterImage, stage6UnsettledSchema } from "../../../src/stages/s6/s6-view.js";
import { useStage6 } from "../../../src/stages/s6/use-stage6.js";
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
const PICK_KEY = "hellVueS6Pick:123456";
const TASK_KEY = "hellVueS6Task:123456";
const LOST_KEY = "hellVueS6Generate:123456";
const COPY = stage6JimuMail.body[1];
/** Short instructions that each pick one candidate type (the scenario's poster tags). */
const {
  pictogram: PICTOGRAM,
  multilingual: MULTILINGUAL,
  textheavy: TEXTHEAVY,
} = stage6Answers.promptByType;

const ids = Array.from(
  { length: 40 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);

/** A Worker for a team in Stage 6, choosing and judging with the domain's own functions. */
class Stage6Server {
  promptLog: string[] = [];
  candidates: S6PosterType[] = [];
  cleared = false;
  readonly commands: Record<string, unknown>[] = [];
  gets = 0;
  /** `GET /game` fails (a lost connection). */
  getsFail = false;
  /** The generations applied, by commandId: a resend of one comes back `duplicate`. */
  readonly generated = new Map<string, { index: number; type: S6PosterType }>();
  /** Replaces the answer to the next commands; `judge` answers as the server would. */
  override: ((judge: () => HttpResponse) => HttpResponse | Promise<HttpResponse>) | null = null;

  view() {
    const base = viewBody(7);
    return {
      ...base,
      state: {
        ...base.state,
        game: {
          ...base.state.game,
          stage: "s6",
          clearedAt: this.cleared ? { s6: new Date(ENTERED_MS + 120_000).toISOString() } : {},
        },
        enteredAt: { s6: ENTERED },
        s6: { promptLog: this.promptLog, candidates: this.candidates },
      },
    };
  }

  handle = (request: HttpRequest): HttpResponse | Promise<HttpResponse> => {
    if (request.path === "/api/session") return ok(sessionBody("123456", 1));
    if (request.path.endsWith("/game")) {
      this.gets++;
      if (this.getsFail) throw new Error("切断");
      return ok(this.view());
    }
    const body =
      typeof request.body === "object" && request.body !== null ? { ...request.body } : {};
    this.commands.push(body);
    const judge = (): HttpResponse => this.judge(body);
    return this.override === null ? judge() : this.override(judge);
  };

  private judge(body: Record<string, unknown>): HttpResponse {
    if (body.type === "s6.generate") {
      const prompt = String(body.prompt);
      const first = this.generated.get(String(body.commandId));
      if (first !== undefined) {
        return ok({
          status: "duplicate",
          original: { events: [], judgement: first },
          ...this.view(),
        });
      }
      if (isS6PromptCopiedFromMail(prompt)) {
        return ok({
          status: "rejected",
          reason: "copied-from-mail",
          judgement: null,
          ...this.view(),
        });
      }
      const type = selectS6PosterType(prompt, this.candidates.at(-1) ?? null);
      const index = this.candidates.length;
      this.promptLog = [...this.promptLog, redactPii(prompt)];
      this.candidates = [...this.candidates, type];
      this.generated.set(String(body.commandId), { index, type });
      return ok({ status: "applied", events: [], judgement: { index, type }, ...this.view() });
    }
    const candidate = this.candidates[Number(body.candidateIndex)];
    if (candidate === undefined) {
      return ok({ status: "rejected", reason: "no-candidate", judgement: null, ...this.view() });
    }
    const judgement = judgeS6Submission(candidate, this.promptLog);
    if (judgement.outcome === "pass") this.cleared = true;
    return ok({ status: "applied", events: [], judgement, ...this.view() });
  }
}

const setup = async (
  prepare: (server: Stage6Server, storage: FakeKeyValueStorage) => void = () => undefined,
  shared?: { server: Stage6Server; storage: FakeKeyValueStorage },
) => {
  const server = shared?.server ?? new Stage6Server();
  const storage = shared?.storage ?? new FakeKeyValueStorage();
  prepare(server, storage);
  const scheduler = new FakeScheduler();
  const played: string[] = [];
  const serverNow = ref(ENTERED_MS);
  const session = createGameSession({
    api: createGameApi(new FakeHttp(server.handle)),
    clock: new FakeClock(new Date(START_MS)),
    // A reload is a new tab: its fresh ids are not the first tab's.
    ids: new FakeIdGenerator(ids.slice(shared === undefined ? 0 : 20)),
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
    sfx: { play: (name) => played.push(name), tone: () => undefined },
    karubeRead: ref(new Set<string>()),
    teamName: ref(""),
  };
  const scope = effectScope();
  const s6 = scope.run(() => useStage6(context));
  if (s6 === undefined) throw new Error("the scope did not run");
  const settle = async (): Promise<void> => {
    await flush();
    await nextTick();
  };
  return { server, storage, scheduler, played, serverNow, s6, scope, settle };
};

const generations = (server: Stage6Server) =>
  server.commands.filter((command) => command.type === "s6.generate");

describe("生成", () => {
  it("待ちの turn を出して s6.generate を送り、応答が先でも2.5秒は待たせる", async () => {
    const { s6, server, scheduler, settle } = await setup();
    // Personal data is blacked out in the waiting bubble too, as the server keeps it.
    const text = `${PICTOGRAM}。担当 090-0000-5678`;
    s6.chat.send(text);
    await settle();
    expect(generations(server)).toEqual([expect.objectContaining({ prompt: text })]);
    expect(server.candidates).toEqual(["pictogram"]);
    const shown = redactPii(text);
    expect(shown).not.toContain("090-0000-5678");
    expect(s6.chat.turns.value).toEqual([
      {
        id: 0,
        text: shown,
        reply: null,
        waitingText: stage6Labels.generating,
        waitingMs: stage6GenerateMs,
      },
    ]);

    scheduler.advanceBy(stage6GenerateMs - 1);
    expect(s6.chat.turns.value[0]?.reply).toBeNull();
    scheduler.advanceBy(1);
    expect(s6.chat.turns.value).toHaveLength(1);
    expect(s6.chat.turns.value[0]).toMatchObject({
      id: 0,
      reply: { image: posterImage("pictogram") },
    });
  });

  it("2.5秒経っても応答が無ければ待ち続け、応答で出る", async () => {
    const { s6, server, scheduler, settle } = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.override = (judge) => gate.then(judge);
    s6.chat.send(MULTILINGUAL);
    await settle();
    scheduler.advanceBy(stage6GenerateMs);
    expect(s6.chat.turns.value[0]?.reply).toBeNull();
    release();
    await settle();
    expect(s6.chat.turns.value[0]?.reply?.image).toEqual(posterImage("multilingual"));
  });

  it("続けて送ると、それぞれ2.5秒待って送った順に出る。タグ無しの指示はサーバの type を描く", async () => {
    const { s6, scheduler, settle } = await setup();
    s6.chat.send(PICTOGRAM);
    await settle();
    scheduler.advanceBy(1_000);
    s6.chat.send(stage6Answers.promptMissingHours);
    await settle();
    scheduler.advanceBy(stage6GenerateMs - 1_000);
    expect(s6.chat.turns.value.map((turn) => [turn.id, turn.reply === null])).toEqual([
      [0, false],
      [1, true],
    ]);
    scheduler.advanceBy(1_000);
    expect(s6.chat.turns.value.map((turn) => turn.reply?.image)).toEqual([
      posterImage("pictogram"),
      posterImage("pictogram"),
    ]);
  });

  it("先の生成が届かなくても、後の生成は出る", async () => {
    const { s6, server, scheduler, settle } = await setup();
    server.override = () => {
      server.override = null;
      return { status: 400, body: { message: "読めません。" } };
    };
    s6.chat.send(PICTOGRAM);
    s6.chat.send(MULTILINGUAL);
    await settle();
    scheduler.advanceBy(stage6GenerateMs);
    expect(s6.chat.turns.value.map((turn) => [turn.id, turn.text])).toEqual([
      [-1, PICTOGRAM],
      [0, MULTILINGUAL],
    ]);
    expect(s6.chat.turns.value[1]?.reply?.image).toEqual(posterImage("multilingual"));
  });

  it("メールの丸写しは送らず turns にも積まず、700ms 後に差し戻しの吹き出し（メモリだけ）", async () => {
    const { s6, server, scheduler, settle } = await setup();
    s6.chat.send(COPY);
    await settle();
    expect(server.commands).toHaveLength(0);
    expect(s6.chat.turns.value).toEqual([{ id: -1, text: COPY, reply: null }]);
    scheduler.advanceBy(stage6CopyRejectDelayMs - 1);
    expect(s6.chat.turns.value[0]?.reply).toBeNull();
    scheduler.advanceBy(1);
    expect(s6.chat.turns.value[0]?.reply).toEqual({ text: stage6CopyReject });

    s6.chat.send(PICTOGRAM);
    await settle();
    scheduler.advanceBy(stage6GenerateMs);
    expect(s6.chat.turns.value.map((turn) => turn.id)).toEqual([-1, 0]);
    expect(server.promptLog).toEqual([PICTOGRAM]);
  });

  it("サーバが丸写しと判じた場合も、待ちを消して差し戻しの吹き出しにする", async () => {
    const { s6, server, scheduler, settle } = await setup();
    server.override = () =>
      ok({ status: "rejected", reason: "copied-from-mail", judgement: null, ...server.view() });
    s6.chat.send(PICTOGRAM);
    await settle();
    expect(s6.chat.turns.value).toEqual([{ id: -1, text: PICTOGRAM, reply: null }]);
    scheduler.advanceBy(stage6CopyRejectDelayMs);
    expect(s6.chat.turns.value[0]?.reply).toEqual({ text: stage6CopyReject });
  });

  it("届いたか分からなければ、待ちを消して案内を出し、状態を読み直す（二重に描かない）", async () => {
    const { s6, server, scheduler, settle } = await setup();
    const before = server.gets;
    server.override = () => ({ status: 400, body: { message: "読めません。" } });
    s6.chat.send(PICTOGRAM);
    await settle();
    scheduler.advanceBy(stage6GenerateMs);
    expect(s6.chat.turns.value).toEqual([
      { id: -1, text: PICTOGRAM, reply: { text: chatSendNotices.unavailable } },
    ]);
    expect(server.gets).toBe(before + 1);
    expect(server.candidates).toEqual([]);
  });

  it.each([
    ["1回目が通り2回目の応答が失われた", [false, true]],
    ["1回目の応答が失われ2回目が通った", [true, false]],
  ])("同じ文を続けて2回送り、%s場合も取り違えない", async (_label, lost) => {
    const { s6, server, scheduler, settle } = await setup();
    let sent = 0;
    server.override = (judge) =>
      lost[sent++] === true ? { status: 400, body: { message: "読めません。" } } : judge();
    s6.chat.send(PICTOGRAM);
    s6.chat.send(PICTOGRAM);
    await settle();
    scheduler.advanceBy(stage6GenerateMs);
    expect(server.candidates).toHaveLength(1);
    const unavailable = { text: chatSendNotices.unavailable };
    const note = { id: -1, text: PICTOGRAM, reply: unavailable };
    const poster = expect.objectContaining({ id: 0, text: PICTOGRAM });
    expect(s6.chat.turns.value).toEqual(lost[0] === true ? [note, poster] : [poster, note]);
  });

  it("適用された後に応答が失われたら、読み直した会話に合流して案内は出さない（二重に見せない）", async () => {
    const { s6, server, scheduler, settle } = await setup();
    server.override = (judge) => {
      judge();
      return { status: 400, body: { message: "読めません。" } };
    };
    s6.chat.send(PICTOGRAM);
    await settle();
    // The state read again has it at once, but the wait is still 2.5 s (decision 10).
    scheduler.advanceBy(stage6GenerateMs - 1);
    expect(s6.chat.turns.value).toEqual([
      {
        id: 0,
        text: PICTOGRAM,
        reply: null,
        waitingText: stage6Labels.generating,
        waitingMs: stage6GenerateMs,
      },
    ]);
    scheduler.advanceBy(1);
    expect(server.promptLog).toEqual([PICTOGRAM]);
    expect(s6.chat.turns.value).toEqual([
      expect.objectContaining({
        id: 0,
        text: PICTOGRAM,
        reply: expect.objectContaining({ text: "" }),
      }),
    ]);
  });
});

describe("届いたか分からない生成", () => {
  const unavailable = { text: chatSendNotices.unavailable };

  /** The next generation's answer and every state read after it are lost; `applied`: it landed. */
  const loseNext = (server: Stage6Server, applied: boolean): void => {
    server.override = (judge) => {
      if (applied) judge();
      server.override = null;
      server.getsFail = true;
      return { status: 400, body: { message: "読めません。" } };
    };
  };

  /** Sends `text`, lets its 2.5 s pass, and returns its commandId. */
  const sendAndWait = async (
    stage: Awaited<ReturnType<typeof setup>>,
    text: string,
  ): Promise<unknown> => {
    stage.s6.chat.send(text);
    await stage.settle();
    stage.scheduler.advanceBy(stage6GenerateMs);
    return generations(stage.server).at(-1)?.commandId;
  };

  it("未確定が2件あっても、それぞれ同じ本文の送り直しは自分の commandId で送る", async () => {
    const stage = await setup((server) => {
      loseNext(server, true);
    });
    const a = await sendAndWait(stage, PICTOGRAM);
    loseNext(stage.server, false);
    const b = await sendAndWait(stage, MULTILINGUAL);
    expect(stage.s6.chat.turns.value.map((turn) => turn.id)).toEqual([-1, -2]);
    expect(await sendAndWait(stage, PICTOGRAM)).toBe(a);
    expect(await sendAndWait(stage, MULTILINGUAL)).toBe(b);
    expect(stage.server.candidates).toHaveLength(2);
  });

  it("再読み込みで適用済みと分かった未確定は消し、同じ指示は新しい ID で新しい候補になる", async () => {
    const first = await setup((server) => {
      loseNext(server, true);
    });
    const lost = await sendAndWait(first, PICTOGRAM);
    expect(first.storage.getItem(LOST_KEY)).not.toBeNull();
    first.scope.stop();

    first.server.getsFail = false;
    const again = await setup(() => undefined, first);
    expect(first.storage.getItem(LOST_KEY)).toBeNull();
    expect(await sendAndWait(again, PICTOGRAM)).not.toBe(lost);
    expect(first.server.candidates).toHaveLength(2);
    expect(again.s6.chat.turns.value.map((turn) => turn.id)).toEqual([0, 1]);
  });

  it("届かなかった案内は、後で読んだ状態に適用が見えたら消える", async () => {
    const stage = await setup((server) => {
      loseNext(server, true);
    });
    await sendAndWait(stage, PICTOGRAM);
    expect(stage.s6.chat.turns.value).toEqual([{ id: -1, text: PICTOGRAM, reply: unavailable }]);
    stage.server.getsFail = false;
    await sendAndWait(stage, MULTILINGUAL);
    expect(stage.s6.chat.turns.value.map((turn) => [turn.id, turn.text])).toEqual([
      [0, PICTOGRAM],
      [1, MULTILINGUAL],
    ]);
  });

  it("送る前に保存し、応答が来たら消す。同じ文を続けて送ると、それぞれ別の候補になる", async () => {
    const stage = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stage.server.override = (judge) => gate.then(judge);
    stage.s6.chat.send(PICTOGRAM);
    stage.s6.chat.send(PICTOGRAM);
    await stage.settle();
    expect(stage.storage.getItem(LOST_KEY)).not.toBeNull();
    const [first, second] = generations(stage.server).map((command) => command.commandId);
    expect(first).not.toBe(second);
    release();
    await stage.settle();
    stage.scheduler.advanceBy(stage6GenerateMs);
    expect(stage.storage.getItem(LOST_KEY)).toBeNull();
    expect(stage.server.candidates).toHaveLength(2);
  });

  it("応答を待つ間に再読み込みすると、同じ commandId で送り直して候補を出し、二重に作らない", async () => {
    const first = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first send reaches the Worker, which applies it only after the reload has read the state.
    first.server.override = (judge) => gate.then(judge);
    first.s6.chat.send(MULTILINGUAL);
    await first.settle();
    const sent = generations(first.server)[0]?.commandId;
    first.scope.stop();

    first.server.override = null;
    const again = await setup(() => undefined, first);
    expect(generations(first.server).map((command) => command.commandId)).toEqual([sent, sent]);
    expect(again.s6.chat.turns.value).toEqual([
      {
        id: 0,
        text: MULTILINGUAL,
        reply: null,
        waitingText: stage6Labels.generating,
        waitingMs: stage6GenerateMs,
      },
    ]);
    await again.settle();
    again.scheduler.advanceBy(stage6GenerateMs);
    expect(again.s6.chat.turns.value[0]?.reply?.image).toEqual(posterImage("multilingual"));

    // The first send lands late: the server knows its commandId and makes nothing more.
    release();
    await again.settle();
    expect(first.server.candidates).toEqual(["multilingual"]);
    expect(first.storage.getItem(LOST_KEY)).toBeNull();
  });

  const keptEntries = (storage: FakeKeyValueStorage) =>
    stage6UnsettledSchema.parse(JSON.parse(storage.getItem(LOST_KEY) ?? "null")).entries;

  it("応答待ちが5件あると、新しい生成は送らず保存もせず、待つよう知らせる", async () => {
    const stage = await setup();
    stage.server.override = () => new Promise<HttpResponse>(() => undefined);
    const texts = [PICTOGRAM, MULTILINGUAL, "図解で", "中国語で", "イラストで"];
    for (const text of texts) stage.s6.chat.send(text);
    await stage.settle();
    stage.s6.chat.send("やさしい日本語で");
    await stage.settle();
    expect(keptEntries(stage.storage).map((entry) => entry.text)).toEqual(texts);
    expect(stage.s6.chat.turns.value.at(-1)).toEqual({
      id: -1,
      text: "やさしい日本語で",
      reply: { text: stage6GenerateBusy },
    });
    expect(generations(stage.server).map((command) => command.prompt)).not.toContain(
      "やさしい日本語で",
    );
  });

  it("サーバが受け取らない長さの指示は送らず保存もしない", async () => {
    const stage = await setup();
    const text = "絵".repeat(CHAT_MESSAGE_MAX_CHARS + 1);
    stage.s6.chat.send(text);
    await stage.settle();
    expect(generations(stage.server)).toHaveLength(0);
    expect(stage.storage.getItem(LOST_KEY)).toBeNull();
    expect(stage.s6.chat.turns.value).toEqual([
      { id: -1, text, reply: { text: chatSendNotices.tooLong } },
    ]);
  });

  it("適用済みと応答待ちが混ざった記録で再読み込みしても、未適用の分は全部同じ commandId で送り直す", async () => {
    const applied = [PICTOGRAM, MULTILINGUAL];
    const waiting = ["図解で", "中国語で", "イラストで", "やさしい日本語で", "文字で"];
    const entries = [...waiting, ...applied].map((text, i) => ({
      text,
      commandId: ids[30 + i] ?? "",
      sentAtCount: 0,
    }));
    const stage = await setup((server, storage) => {
      server.promptLog = [...applied];
      server.candidates = ["pictogram", "multilingual"];
      storage.setItem(LOST_KEY, JSON.stringify({ enteredAt: ENTERED, entries }));
    });
    // The session sends one command at a time: one settle per resend.
    for (let i = 0; i < waiting.length; i++) await stage.settle();
    expect(generations(stage.server).map((command) => [command.prompt, command.commandId])).toEqual(
      entries.slice(0, waiting.length).map((entry) => [entry.text, entry.commandId]),
    );
    expect(stage.server.promptLog).toEqual([...applied, ...waiting]);
    expect(stage.storage.getItem(LOST_KEY)).toBeNull();
  });

  it("応答が失われた未確定は古いものから切り詰め、5件までしか持たない", async () => {
    const stage = await setup();
    stage.server.override = () => ({ status: 400, body: { message: "読めません。" } });
    const texts = ["一", "二", "三", "四", "五", "六"].map((text) => `${text}の絵で`);
    for (const text of texts) {
      stage.s6.chat.send(text);
      await stage.settle();
    }
    expect(keptEntries(stage.storage).map((entry) => entry.text)).toEqual(texts.slice(1));
  });

  it("再読み込みの時点で適用済みなら送り直さない", async () => {
    const first = await setup();
    // Applied, but the page is gone before the answer arrives.
    first.server.override = (judge) => {
      judge();
      return new Promise<HttpResponse>(() => undefined);
    };
    first.s6.chat.send(MULTILINGUAL);
    await first.settle();
    first.scope.stop();

    first.server.override = null;
    const again = await setup(() => undefined, first);
    expect(generations(first.server)).toHaveLength(1);
    expect(first.storage.getItem(LOST_KEY)).toBeNull();
    expect(again.s6.chat.turns.value).toEqual([
      expect.objectContaining({ id: 0, text: MULTILINGUAL }),
    ]);
  });

  it("個人情報を含む本文は保存せず、メモリだけで同じ commandId を使う", async () => {
    const stage = await setup((server) => {
      loseNext(server, true);
    });
    const text = `${PICTOGRAM}。担当 090-0000-5678`;
    const lost = await sendAndWait(stage, text);
    expect(stage.storage.getItem(LOST_KEY)).toBeNull();
    expect(await sendAndWait(stage, text)).toBe(lost);
    expect(stage.server.candidates).toHaveLength(1);
  });
});

describe("送信の禁止", () => {
  it("クリア後は送らない", async () => {
    const { s6, server, settle } = await setup((srv) => {
      srv.cleared = true;
    });
    s6.chat.send(PICTOGRAM);
    await settle();
    expect(server.commands).toHaveLength(0);
    expect(s6.chat.turns.value).toEqual([]);
  });
});

describe("選択と再読み込み", () => {
  const withTwo = (server: Stage6Server): void => {
    server.promptLog = [TEXTHEAVY, stage6Answers.promptOk];
    server.candidates = ["textheavy", "pictogram"];
  };

  it("会話と選択が戻る（決定8・9）", async () => {
    const first = await setup(withTwo);
    expect(first.s6.chat.turns.value.map((turn) => turn.text)).toEqual(first.server.promptLog);
    expect(first.s6.selected.value).toBeNull();
    first.s6.chat.turns.value[1]?.reply?.action?.run();
    expect(first.s6.selected.value).toEqual({ index: 1, image: posterImage("pictogram") });
    expect(JSON.parse(first.storage.getItem(PICK_KEY) ?? "null")).toEqual({
      enteredAt: ENTERED,
      index: 1,
    });
    first.scope.stop();

    const again = await setup(() => undefined, first);
    expect(again.s6.chat.turns.value.map((turn) => turn.id)).toEqual([0, 1]);
    expect(again.s6.selected.value?.index).toBe(1);
  });

  it.each([
    ["JSON でない", "{"],
    ["形が違う", JSON.stringify({ enteredAt: ENTERED, index: "1" })],
    ["範囲外", JSON.stringify({ enteredAt: ENTERED, index: 2 })],
  ])("保存が壊れていたら（%s）捨てる", async (_label, saved) => {
    const { s6, storage } = await setup((server, kept) => {
      withTwo(server);
      kept.setItem(PICK_KEY, saved);
    });
    expect(s6.selected.value).toBeNull();
    expect(storage.getItem(PICK_KEY)).toBeNull();
  });

  it("別の入場の選択は使わない", async () => {
    const { s6 } = await setup((server, kept) => {
      withTwo(server);
      kept.setItem(PICK_KEY, JSON.stringify({ enteredAt: "2026-01-01T00:00:00.000Z", index: 0 }));
    });
    expect(s6.selected.value).toBeNull();
  });
});

describe("提出", () => {
  const ready = (server: Stage6Server, storage: FakeKeyValueStorage): void => {
    server.promptLog = [TEXTHEAVY, stage6Answers.promptOk];
    server.candidates = ["textheavy", "pictogram"];
    storage.setItem(PICK_KEY, JSON.stringify({ enteredAt: ENTERED, index: 0 }));
  };

  it("未選択なら送らない", async () => {
    const { s6, server, settle } = await setup();
    s6.submit();
    await settle();
    expect(server.commands).toHaveLength(0);
  });

  it("差し戻しは近藤さんの台詞・警告色・cancel、選び直して通ればクリア", async () => {
    const { s6, server, played, settle } = await setup(ready);
    s6.submit();
    s6.submit();
    expect(s6.verdict.value).toEqual({ kind: "checking" });
    await settle();
    expect(server.commands).toEqual([
      expect.objectContaining({ type: "s6.submit", candidateIndex: 0 }),
    ]);
    expect(s6.verdict.value).toEqual({ kind: "rejected", lines: [stage6RejectType.textheavy] });
    expect(s6.warn.value).toBe(true);
    expect(played).toEqual(["cancel"]);

    s6.chat.turns.value[1]?.reply?.action?.run();
    s6.submit();
    await settle();
    expect(s6.cleared.value).toBe(true);
    expect(s6.verdict.value).toEqual({ kind: "cleared", text: "Stage 6 をクリアしました" });
    expect(s6.warn.value).toBe(false);
  });

  it("届いたか分からなければ同じ commandId で送り直す", async () => {
    const { s6, server, settle } = await setup(ready);
    server.override = () => ({ status: 400, body: { message: "読めません。" } });
    s6.submit();
    await settle();
    expect(s6.verdict.value).toEqual({ kind: "rejected", lines: [stage6SendFailed] });
    server.override = null;
    s6.submit();
    await settle();
    expect(server.commands[1]?.commandId).toBe(server.commands[0]?.commandId);
  });

  it("クリア後は候補を選べず、提出もしない", async () => {
    const { s6, server, storage, settle } = await setup((srv, kept) => {
      ready(srv, kept);
      srv.cleared = true;
    });
    s6.chat.turns.value[1]?.reply?.action?.run();
    s6.submit();
    await settle();
    expect(server.commands).toHaveLength(0);
    expect(JSON.parse(storage.getItem(PICK_KEY) ?? "null")).toMatchObject({ index: 0 });
  });
});

describe("事務長の一報と苅部さん", () => {
  it("一報は入場で開き、閉じたら記録して再読み込みでは出さない", async () => {
    const first = await setup();
    expect(first.s6.taskOpen.value).toBe(true);
    first.s6.closeTask();
    expect(first.s6.taskOpen.value).toBe(false);
    expect(JSON.parse(first.storage.getItem(TASK_KEY) ?? "null")).toEqual({ enteredAt: ENTERED });
    first.scope.stop();
    const again = await setup(() => undefined, first);
    expect(again.s6.taskOpen.value).toBe(false);
  });

  it("苅部さんは入場から40秒で1本だけ", async () => {
    const { s6, serverNow, settle } = await setup();
    serverNow.value = ENTERED_MS + 39_999;
    await settle();
    expect(s6.karube.value).toEqual([]);
    serverNow.value = ENTERED_MS + 40_000;
    await settle();
    expect(s6.karube.value.map((call) => call.callId)).toEqual([`s6:${ENTERED}`]);
    serverNow.value = ENTERED_MS + 400_000;
    await settle();
    expect(s6.karube.value).toHaveLength(1);
  });
});
