import { chatPrepareFailed, chatSendNotices, rateLimitNotice } from "@hell-ict/content";
import { pendingKey, stage5Patient, storedPendingText } from "@hell-ict/domain";
import type { StageAi } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatApi } from "../../src/api/chat-api.js";
import { createGameApi } from "../../src/api/game-api.js";
import { createStageChat, pendingStorageKey } from "../../src/chat/use-stage-chat.js";
import type { StageChat } from "../../src/chat/use-stage-chat.js";
import {
  createGameSession,
  TEAM_CODE_STORAGE_KEY,
} from "../../src/composables/use-game-session.js";
import type { HttpRequest, HttpResponse } from "../../src/ports.js";
import {
  chatMessageBody,
  chatSnapshotBody,
  deferred,
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  staleGeneration,
  START_MS,
  unavailable,
  viewBody,
} from "../fakes.js";

const TEAM = "123456";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";

/** The chat's command ids (the session's own ids start with 00000000). */
const CHAT_IDS = Array.from(
  { length: 20 },
  (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);
const SESSION_IDS = Array.from(
  { length: 20 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

const ready = (threadId: string, live = true): StageAi => ({ status: "ready", threadId, live });

type Message = ReturnType<typeof chatMessageBody>;

const bodyOf = (request: HttpRequest | undefined): Record<string, unknown> => {
  const body = request?.body;
  return typeof body === "object" && body !== null ? { ...body } : {};
};

/**
 * The Worker's game and chat routes, enough for the pane: `GET /game` names the stage's thread,
 * `GET /chat` answers every thread (and where the asked ids stand), and a message is answered by
 * `onMessage` (by default the AI replies and both messages are stored).
 */
class FakeChatServer {
  ai: StageAi = ready(S3);
  /** The reset generation `POST /api/session` gives. */
  generation = 3;
  revision = 1;
  threads: Record<string, Message[]> = {
    [S2]: [
      chatMessageBody(1, "user", "前のステージの質問"),
      chatMessageBody(2, "assistant", "前の回答"),
    ],
    [S3]: [],
  };
  commands: Record<string, "pending" | "processed" | "unknown"> = {};
  onMessage: ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>) | null = null;
  /** Answers the next `GET /chat` instead of the threads (then goes back to them). */
  onChat: (() => Promise<HttpResponse>) | null = null;
  private seq = 10;

  handle = (request: HttpRequest): HttpResponse | Promise<HttpResponse> => {
    if (request.path === "/api/session") {
      return ok(sessionBody(String(bodyOf(request).teamCode), this.generation));
    }
    if (request.path.endsWith("/game")) return ok({ ...viewBody(0), ai: this.ai });
    if (request.path.endsWith("/game/chat/thread")) return ok({ ...viewBody(0), ai: this.ai });
    if (request.path.endsWith("/game/chat/messages")) {
      return this.onMessage === null ? this.reply(request) : this.onMessage(request);
    }
    const held = this.onChat;
    if (held !== null) {
      this.onChat = null;
      return held();
    }
    return ok(this.snapshot(request.path));
  };

  /** The AI answers: both messages are stored in the current stage's thread. */
  reply = (request: HttpRequest): HttpResponse => {
    const text = String(bodyOf(request).text);
    const threadId = this.ai.status === "ready" ? this.ai.threadId : S3;
    const assistant = chatMessageBody((this.seq += 2), "assistant", `回答: ${text}`);
    this.threads[threadId] = [
      ...(this.threads[threadId] ?? []),
      chatMessageBody(this.seq - 1, "user", text),
      assistant,
    ];
    this.revision += 1;
    return ok({ snapshot: chatSnapshotBody(this.revision, this.threads), assistant });
  };

  private snapshot(path: string) {
    const query = new URL(path, "http://x").searchParams.get("commandIds");
    const asked =
      query === null
        ? undefined
        : Object.fromEntries(
            query.split(",").map((id) => [id, this.commands[id] ?? ("unknown" as const)]),
          );
    return chatSnapshotBody(this.revision, this.threads, asked);
  }
}

const error = (status: number, body: unknown, retryAfter?: string): HttpResponse => ({
  status,
  body,
  ...(retryAfter === undefined ? {} : { retryAfter }),
});

let chats: StageChat[] = [];
afterEach(() => {
  for (const chat of chats) chat.dispose();
  chats = [];
});

interface SetupOptions {
  /** A server prepared before entering (its answer to the first `GET /chat` matters). */
  readonly server?: FakeChatServer;
  /** What sessionStorage holds for the team before entering. */
  readonly pending?: string;
  /** sessionStorage throws on every call. */
  readonly failing?: boolean;
}

const setup = async (options: SetupOptions = {}) => {
  const server = options.server ?? new FakeChatServer();
  const http = new FakeHttp(server.handle);
  const local = new FakeKeyValueStorage();
  local.values.set(TEAM_CODE_STORAGE_KEY, TEAM);
  const storage = new FakeKeyValueStorage();
  if (options.pending !== undefined) storage.values.set(pendingStorageKey(TEAM), options.pending);
  storage.failing = options.failing ?? false;
  const clock = new FakeClock(new Date(START_MS));
  const session = createGameSession({
    api: createGameApi(http),
    clock,
    ids: new FakeIdGenerator(SESSION_IDS),
    storage: local,
    scheduler: new FakeScheduler(),
    resume: new FakeResumeSignal(),
  });
  const chat = createStageChat({
    api: createChatApi(http, clock),
    session,
    ids: new FakeIdGenerator(CHAT_IDS),
    storage,
  });
  chats.push(chat);
  await session.start();
  await flush();
  const posts = (): Record<string, unknown>[] => http.to("/game/chat/messages").map(bodyOf);
  /** Every `GET /chat`, with or without `?commandIds=`. */
  const chatGets = (): string[] =>
    http.requests
      .filter((request) => request.method === "GET" && /\/chat(\?|$)/.test(request.path))
      .map((request) => request.path);
  const type = async (text: string): Promise<void> => {
    chat.draft.value = text;
    await chat.send();
    await flush();
  };
  const texts = (): string[] =>
    chat.items.value.map((item) => ("text" in item ? item.text : item.kind));
  return { server, http, storage, session, chat, posts, chatGets, type, texts };
};

describe("入室と表示", () => {
  it("今のステージのスレッドだけを描き、空なら挨拶を出す（前のステージの会話へ落ちない）", async () => {
    const { chat, chatGets } = await setup();
    expect(chatGets()).toEqual([`/api/teams/${TEAM}/chat`]);
    expect(chat.mode.value).toBe("live");
    expect(chat.items.value).toEqual([{ kind: "greeting", key: "greeting" }]);
  });

  it("送信するとAIの応答が出て、自分の発言と応答が並ぶ", async () => {
    const { chat, type, posts, texts } = await setup();
    await type("  斑紋症の対応は？  ");
    expect(posts()).toEqual([
      { type: "stage-message", commandId: CHAT_IDS[0], generation: 3, text: "斑紋症の対応は？" },
    ]);
    expect(texts()).toEqual(["斑紋症の対応は？", "回答: 斑紋症の対応は？"]);
    expect(chat.draft.value).toBe("");
  });

  it("空白だけの本文は送らない", async () => {
    const { type, posts } = await setup();
    await type("   \n ");
    expect(posts()).toHaveLength(0);
  });
});

describe("送信中", () => {
  it("送った瞬間に入力欄を空にし、自分の吹き出しと「入力中」を出す。2回押しても POST は1回", async () => {
    const { server, chat, posts } = await setup();
    const answer = deferred();
    server.onMessage = () => answer.promise;
    chat.draft.value = "質問";
    const first = chat.send();
    chat.draft.value = "質問";
    const second = chat.send();
    await flush();
    expect(posts()).toHaveLength(1);
    expect(chat.sending.value).toBe(true);
    expect(chat.items.value.map((item) => item.kind)).toEqual(["message", "typing"]);
    answer.resolve(unavailable());
    await Promise.all([first, second]);
    expect(chat.sending.value).toBe(false);
  });
});

describe("PII の跡を残さない（ユーザー決定1）", () => {
  /** A mark that appears only in the text sent: found anywhere, the text left a trace. */
  const MARK = "印PII7731";
  const PII_TEXT = `${stage5Patient.name}さんの件 ${MARK}`;
  const writtenValues = (storage: { setItem: (key: string, value: string) => void }) => {
    const spy = vi.spyOn(storage, "setItem");
    return (): string[] => spy.mock.calls.map(([key, value]) => `${key}=${value}`);
  };

  it("送信中も自分の吹き出しを出さず、sessionStorage に何も書かない。止まった後は入力欄に本文が戻る", async () => {
    const { server, chat, storage, texts } = await setup();
    const written = writtenValues(storage);
    const answer = deferred();
    server.onMessage = () => answer.promise;
    chat.draft.value = PII_TEXT;
    const sent = chat.send();
    await flush();
    expect(chat.sending.value).toBe(true);
    expect(texts().join("")).not.toContain(MARK);
    expect(written()).toEqual([]);
    answer.resolve(error(422, { message: "個人情報を検知しました。", code: "pii_blocked" }));
    await sent;
    await flush();
    expect(chat.draft.value).toBe(PII_TEXT);
    expect(texts()).toEqual([chatSendNotices.piiBlocked]);
    expect(written()).toEqual([]);
    expect([...storage.values.values()].join("")).not.toContain(MARK);
  });

  it.each<[string, () => HttpResponse]>([
    ["422 pii_blocked", () => error(422, { message: "検知", code: "pii_blocked" })],
    ["429", () => error(429, { message: "多すぎます。" }, "5")],
    ["503", unavailable],
    [
      "切断",
      () => {
        throw new Error("connection lost");
      },
    ],
  ])("%s のどれでも GET /game を読み直し、本文の印をどこにも残さない", async (_case, answer) => {
    const { server, chat, storage, http, type, texts, posts } = await setup();
    const written = writtenValues(storage);
    server.onMessage = answer;
    const gamesBefore = http.to("/game").length;
    await type(PII_TEXT);
    expect(http.to("/game")).toHaveLength(gamesBefore + 1);
    expect(written()).toEqual([]);
    expect([...storage.values.values()].join("")).not.toContain(MARK);
    expect(texts().join("")).not.toContain(MARK);
    expect(chat.draft.value).toBe(PII_TEXT);
    // Pressed again: a fresh id, since the text's id was never kept.
    await chat.send();
    await flush();
    expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[1]]);
  });

  it("PII でない送信は従来どおり: 送信中は吹き出しを出し、未確定の id を保存し、503 で game は読み直さない", async () => {
    const { server, chat, storage, http, texts } = await setup();
    const answer = deferred();
    server.onMessage = () => answer.promise;
    const gamesBefore = http.to("/game").length;
    chat.draft.value = "質問";
    const sent = chat.send();
    await flush();
    expect(texts()).toEqual(["質問", "typing"]);
    expect(storage.values.get(pendingStorageKey(TEAM))).toBe(
      storedPendingText(new Map([[pendingKey(S3, "質問"), CHAT_IDS[0] ?? ""]])),
    );
    answer.resolve(unavailable());
    await sent;
    await flush();
    expect(http.to("/game")).toHaveLength(gamesBefore);
  });

  describe("C3 より前の画面が本文入りで残した未確定 id", () => {
    const earlier = storedPendingText(
      new Map([
        [pendingKey(S3, PII_TEXT), CHAT_IDS[18] ?? ""],
        [pendingKey(S3, "普通の質問"), CHAT_IDS[19] ?? ""],
      ]),
    );
    const kept = storedPendingText(new Map([[pendingKey(S3, "普通の質問"), CHAT_IDS[19] ?? ""]]));

    it("入室（再読み込み）で読んだら、照会が unknown でも PII の項目だけを保存領域から消す", async () => {
      const { storage } = await setup({ pending: earlier });
      expect(storage.values.get(pendingStorageKey(TEAM))).toBe(kept);
    });

    it.each<[string, () => HttpResponse]>([
      ["429", () => error(429, { message: "多すぎます。" }, "5")],
      ["503", unavailable],
    ])(
      "同じ本文を送って %s でも、古い id を使わず、保存領域にもメモリにも残さない",
      async (_case, answer) => {
        const { server, chat, storage, type, posts } = await setup({ pending: earlier });
        server.onMessage = answer;
        await type(PII_TEXT);
        expect([...storage.values.values()].join("")).not.toContain(MARK);
        await chat.send();
        await flush();
        // Neither the stored id nor the first send's id comes back: nothing held the text.
        expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[1]]);
        expect(storage.values.get(pendingStorageKey(TEAM))).toBe(kept);
      },
    );
  });
});

describe("失敗", () => {
  it("503 のあとは本文が入力欄に戻り、同じ本文の再送は同じ commandId", async () => {
    const { server, chat, type, posts, texts, chatGets } = await setup();
    server.onMessage = () => unavailable();
    await type("質問");
    expect(chat.draft.value).toBe("質問");
    expect(texts()).toEqual([chatSendNotices.unavailable]);
    // 保存されたか分からないので GET /chat で描き直す（入室の1回＋1回）。
    expect(chatGets()).toHaveLength(2);
    server.onMessage = null;
    await chat.send();
    await flush();
    expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[0]]);
  });

  it("422 pii_blocked のあとは GET /game を取り直し、同じ本文でも新しいIDで送る", async () => {
    const { server, chat, type, posts, texts, http } = await setup();
    server.onMessage = () =>
      error(422, { message: "個人情報を検知しました。", code: "pii_blocked" });
    const gamesBefore = http.to("/game").length;
    await type(`${stage5Patient.name}さんの件`);
    expect(chat.draft.value).toBe(`${stage5Patient.name}さんの件`);
    expect(texts()).toEqual([chatSendNotices.piiBlocked]);
    expect(http.to("/game")).toHaveLength(gamesBefore + 1);
    await chat.send();
    await flush();
    expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[1]]);
  });

  it("429 は待ち時間を告げるだけで、自分からは送り直さない", async () => {
    const { server, type, posts, texts } = await setup();
    server.onMessage = () => error(429, { message: "多すぎます。" }, "17");
    await type("質問");
    expect(texts()).toEqual([rateLimitNotice(17)]);
    await flush();
    expect(posts()).toHaveLength(1);
  });

  it("422 の拒否は保存済みのユーザー発言を取り直し、その後ろにサーバの言葉を出す", async () => {
    const { server, type, texts } = await setup();
    server.onMessage = (request) => {
      server.threads[S3] = [chatMessageBody(5, "user", String(bodyOf(request).text))];
      server.revision += 1;
      return error(422, { message: "回答できません。", code: "ai_refusal" });
    };
    await type("質問");
    expect(texts()).toEqual(["質問", "回答できません。"]);
  });

  it("409 stale-generation のあとはタブを古いものにし、以後は POST も保存もしない", async () => {
    const { server, chat, session, storage, type, posts } = await setup();
    server.onMessage = () => staleGeneration();
    await type("質問");
    expect(session.status.value).toBe("stale");
    const saved = storage.values.get(pendingStorageKey(TEAM));
    chat.draft.value = "別の質問";
    await chat.send();
    await chat.retryPrepare();
    await flush();
    expect(posts()).toHaveLength(1);
    expect(storage.values.get(pendingStorageKey(TEAM))).toBe(saved);
  });

  it.each([
    ["別のチームへ入室した", "654321", 3],
    ["同じチームへ入り直して世代が変わった", TEAM, 4],
  ])(
    "送信の応答を待つ間に%s後の 409 stale-generation は、今の画面を stale にしない",
    async (_case, nextTeam, nextGeneration) => {
      const { server, session, chat, texts } = await setup();
      const answer = deferred();
      server.onMessage = () => answer.promise;
      chat.draft.value = "質問";
      const sent = chat.send();
      await flush();
      server.generation = nextGeneration;
      await session.join(nextTeam);
      await flush();
      answer.resolve(staleGeneration());
      await sent;
      await flush();
      expect(session.status.value).toBe("ready");
      expect(session.teamCode.value).toBe(nextTeam);
      expect(texts()).toEqual(["greeting"]);
      expect(chat.draft.value).toBe("");
    },
  );

  it("同じチーム・同じ世代で入り直した後に旧送信の失敗が届いても、本文もお知らせも戻さない", async () => {
    const { server, session, chat, texts } = await setup();
    const answer = deferred();
    server.onMessage = () => answer.promise;
    chat.draft.value = "質問";
    const sent = chat.send();
    await flush();
    await session.join(TEAM);
    await flush();
    answer.resolve(unavailable());
    await sent;
    await flush();
    expect(session.status.value).toBe("ready");
    expect(texts()).toEqual(["greeting"]);
    expect(chat.draft.value).toBe("");
  });

  it("同じチームへ入り直すと GET /chat をやり直し、旧い会話とお知らせを消してサーバの新しい発言を出す", async () => {
    const { server, session, chat, texts, chatGets, type } = await setup();
    server.onMessage = () => unavailable();
    await type("質問");
    expect(texts()).toEqual([chatSendNotices.unavailable]);
    const before = chatGets().length;
    // 入室している間に、別の端末からの発言がサーバに保存された。
    server.threads[S3] = [chatMessageBody(50, "user", "別の端末の発言")];
    server.revision += 1;
    await session.join(TEAM);
    await flush();
    expect(chatGets()).toHaveLength(before + 1);
    expect(texts()).toEqual(["別の端末の発言"]);
    expect(chat.draft.value).toBe("");
  });

  it("旧送信の後の GET /chat の取得中に同じチームへ入り直すと、旧い応答は反映しない", async () => {
    const { server, session, chat, texts } = await setup();
    server.onMessage = () => unavailable();
    const oldChat = deferred();
    server.onChat = () => oldChat.promise;
    chat.draft.value = "質問";
    const sent = chat.send();
    await flush();
    // The send's refetch of the chat is now held. Join again (same team, same generation).
    await session.join(TEAM);
    await flush();
    server.revision = 99;
    server.threads[S3] = [chatMessageBody(40, "user", "旧いセッションの発言")];
    oldChat.resolve(ok(chatSnapshotBody(99, server.threads)));
    await sent;
    await flush();
    expect(texts()).not.toContain("旧いセッションの発言");
  });
});

describe("ステージの切り替え", () => {
  it("書きかけの本文は次のステージの入力欄へ持ち込まない（別のAIへ送れてしまう）", async () => {
    const { server, session, chat, posts } = await setup();
    chat.draft.value = "Stage 3 のAIに聞くつもりの本文";
    server.threads[S4] = [];
    server.ai = ready(S4);
    await session.refresh();
    await flush();
    expect(chat.draft.value).toBe("");
    await chat.send();
    expect(posts()).toHaveLength(0);
  });

  it("前のステージの会話と notices を消し、新しいスレッドを取りに行く", async () => {
    const { server, session, chat, type, texts } = await setup();
    server.onMessage = () => unavailable();
    await type("s3 の質問");
    expect(texts()).toEqual([chatSendNotices.unavailable]);
    server.threads[S4] = [];
    server.ai = ready(S4);
    await session.refresh();
    await flush();
    expect(chat.items.value).toEqual([{ kind: "greeting", key: "greeting" }]);
  });

  it("応答前にステージが変わると、応答は前のスレッドへ入り、今の画面には出ない", async () => {
    const { server, session, chat, texts } = await setup();
    const answer = deferred();
    server.onMessage = () => answer.promise;
    chat.draft.value = "s3 の質問";
    const sent = chat.send();
    await flush();
    server.threads[S4] = [];
    server.ai = ready(S4);
    await session.refresh();
    await flush();
    expect(chat.items.value.map((item) => item.kind)).toEqual(["greeting"]);
    server.ai = ready(S3);
    answer.resolve(server.reply({ method: "POST", path: "", body: { text: "s3 の質問" } }));
    server.ai = ready(S4);
    await sent;
    expect(texts()).toEqual(["greeting"]);
    // 前のステージの本文を、次のステージの入力欄へ持ち込まない。
    expect(chat.draft.value).toBe("");
  });

  it("失敗の応答が来たとき別ステージにいれば、本文もお知らせも今のペインに出さない", async () => {
    const { server, session, chat } = await setup();
    const answer = deferred();
    server.onMessage = () => answer.promise;
    chat.draft.value = "s3 の質問";
    const sent = chat.send();
    await flush();
    server.threads[S4] = [];
    server.ai = ready(S4);
    await session.refresh();
    answer.resolve(unavailable());
    await sent;
    await flush();
    expect(chat.items.value).toEqual([{ kind: "greeting", key: "greeting" }]);
    expect(chat.draft.value).toBe("");
  });

  it("live=false（s2・s6）は送らない", async () => {
    const { server, session, chat, type, posts } = await setup();
    server.ai = ready(S2, false);
    await session.refresh();
    await flush();
    expect(chat.mode.value).toBe("scripted");
    await type("質問");
    expect(posts()).toHaveLength(0);
    // 前のステージ（s2）の会話そのものは、そのスレッドとして描く。
    expect(chat.items.value.map((item) => item.kind)).toEqual(["message", "message"]);
  });
});

describe("会話の準備の失敗", () => {
  it("failed のときは［再試行］で POST chat/thread を送り、ready になれば会話を出す", async () => {
    const { server, session, chat, http } = await setup();
    server.ai = { status: "failed" };
    await session.refresh();
    await flush();
    expect(chat.mode.value).toBe("failed");
    expect(chatPrepareFailed.text).toBe("会話の準備に失敗しました。");
    server.ai = ready(S3);
    await chat.retryPrepare();
    await flush();
    expect(http.to("/game/chat/thread")).toHaveLength(1);
    expect(chat.mode.value).toBe("live");
  });
});

describe("再読み込み", () => {
  const stored = storedPendingText(
    new Map([
      [pendingKey(S3, "処理済み"), CHAT_IDS[18] ?? ""],
      [pendingKey(S3, "処理中"), CHAT_IDS[19] ?? ""],
    ]),
  );

  it("未確定IDを GET /chat?commandIds= で突き合わせ、processed だけ捨てる", async () => {
    const { chatGets, storage, chat, posts } = await setup({ pending: stored });
    expect(chatGets()).toHaveLength(1);
    expect(chatGets()[0]).toContain(`commandIds=${String(CHAT_IDS[18])}%2C${String(CHAT_IDS[19])}`);
    // 入室の時点では全部 unknown。処理済みの扱いは次のテストで見る。
    expect(storage.values.get(pendingStorageKey(TEAM))).toBe(stored);
    chat.draft.value = "処理中";
    await chat.send();
    expect(posts()[0]?.commandId).toBe(CHAT_IDS[19]);
  });

  it("processed のIDは捨て、同じ本文は新しいIDで送る。pending のIDは残す", async () => {
    const server = new FakeChatServer();
    server.commands = {
      [CHAT_IDS[18] ?? ""]: "processed",
      [CHAT_IDS[19] ?? ""]: "pending",
    };
    const { storage, chat, posts } = await setup({ server, pending: stored });
    const kept = new Map([[pendingKey(S3, "処理中"), CHAT_IDS[19] ?? ""]]);
    expect(storage.values.get(pendingStorageKey(TEAM))).toBe(storedPendingText(kept));
    chat.draft.value = "処理済み";
    await chat.send();
    chat.draft.value = "処理中";
    await chat.send();
    expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[19]]);
  });

  it("sessionStorage が例外を投げても、送信と応答の表示は止まらない", async () => {
    const server = new FakeChatServer();
    const { storage, chat, posts, texts } = await setup({ server, failing: true });
    expect(storage.failing).toBe(true);
    server.onMessage = () => unavailable();
    chat.draft.value = "質問";
    await chat.send();
    server.onMessage = null;
    await chat.send();
    await flush();
    // メモリ上のIDで同じ commandId を使い続ける。
    expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], CHAT_IDS[0]]);
    expect(texts()).toContain("回答: 質問");
  });

  it.each([
    ["同じチームへ入り直した", TEAM, CHAT_IDS[0]],
    ["別のチームへ入室した", "654321", CHAT_IDS[1]],
  ])(
    "sessionStorage が使えないとき、%s後の同じ本文の再送の commandId",
    async (_case, nextTeam, expected) => {
      const server = new FakeChatServer();
      const { session, chat, posts } = await setup({ server, failing: true });
      server.onMessage = () => unavailable();
      chat.draft.value = "質問";
      await chat.send();
      await flush();
      await session.join(nextTeam);
      await flush();
      chat.draft.value = "質問";
      await chat.send();
      // 同じチームならメモリ上の未確定IDを引き継ぎ（二重保存しない）、別チームには持ち込まない。
      expect(posts().map((post) => post.commandId)).toEqual([CHAT_IDS[0], expected]);
    },
  );

  it("壊れた保存値は丸ごと捨て、問い合わせずに入室する", async () => {
    const { chatGets } = await setup({ pending: "{broken" });
    expect(chatGets()).toEqual([`/api/teams/${TEAM}/chat`]);
  });
});
