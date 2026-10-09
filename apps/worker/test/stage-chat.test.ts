import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  chatMessageResultSchema,
  chatSnapshotSchema,
  httpErrorSchema,
  stageAiSchema,
} from "@hell-ict/domain";
import type { ChatSnapshot } from "@hell-ict/domain";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import { beforeEach, describe, expect, it } from "vitest";

import { handleGameState, handlePrepareStageThread } from "../src/game-api.js";
import { AiRouteState, createAiGateway } from "../src/ai-failover.js";
import { handleStageChatMessage } from "../src/stage-chat.js";
import { systemPromptFor } from "../src/stage-prompts.js";
import { advance, applied, CLEAR, command, playTo } from "./game-command-support.js";
import { MAX_STAGE_THREADS_PER_TEAM } from "../src/chat-store.js";
import { clock, countRows, gameOf, gmReset, viewSchema } from "./game-support.js";
import { get, postJson, TEST_ORIGIN } from "./support.js";
import { PII_NAME, PII_SURNAME } from "./pii-support.js";

/**
 * ステージに結び付いたAIチャット（Issue #236）。送り先の会話とシステムプロンプトは
 * サーバがゲーム状態のステージから選ぶ。AIはFakeで、呼ばれた回数と渡った内容を見る。
 */

beforeEach(() => {
  clock.reset();
});

const PATIENT = PII_NAME;

const ok = (text = "応答") => new FakeAiGateway([{ kind: "success", response: text }]);

const post = async (
  teamCode: string,
  body: unknown,
  aiGateway: FakeAiGateway,
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await handleStageChatMessage(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { env, ctx },
    teamCode,
    { aiGateway, nowMs: clock.now().getTime() },
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const message = (text: string, generation = 0) => ({
  type: "stage-message",
  commandId: crypto.randomUUID(),
  generation,
  text,
});

const draft = (mailId: string, material: { context?: string; point?: string } = {}) => ({
  type: "s1-draft",
  commandId: crypto.randomUUID(),
  generation: 0,
  context: "",
  point: "",
  mailId,
  ...material,
});

const errorOf = async (response: Response) => httpErrorSchema.parse(await response.json());

const chatOf = async (teamCode: string): Promise<ChatSnapshot> =>
  chatSnapshotSchema.parse(await (await get(`/api/teams/${teamCode}/chat`)).json());

const threadTitled = async (teamCode: string, title: string) =>
  (await chatOf(teamCode)).threads.find((thread) => thread.title === title);

const allMessages = async (teamCode: string) =>
  (await chatOf(teamCode)).threads.flatMap((thread) => thread.messages.map((m) => m.text));

const aiOf = async (teamCode: string) => {
  const response = await handleGameState(env, teamCode, clock);
  return viewSchema.extend({ ai: stageAiSchema }).parse(await response.json()).ai;
};

/** AIへ渡った先頭（システムプロンプト）。 */
const systemOf = (gateway: FakeAiGateway, index = 0): string | undefined =>
  gateway.requests[index]?.messages[0]?.text;

describe("プロンプトと送り先はステージで決まる", () => {
  it("Stage 3 は Stage 3 の会話へ、Stage 3 のシステムプロンプトを前置して送る", async () => {
    const teamCode = "610001";
    await playTo(teamCode, "s3");
    const gateway = ok("応答");
    const response = await post(teamCode, message("感染対策は？"), gateway);
    expect(response.status).toBe(200);
    const result = chatMessageResultSchema.parse(await response.json());
    expect(result.assistant.text).toBe("応答");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(systemOf(gateway)).toBe(systemPromptFor("s3"));
    expect(systemOf(gateway)).not.toBe(systemPromptFor("default"));
    const stage3 = await threadTitled(teamCode, "Stage 3");
    expect(stage3?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "感染対策は？"],
      ["assistant", "応答"],
    ]);
    // 前のステージの会話には何も入らない。
    expect((await threadTitled(teamCode, "Stage 2"))?.messages).toEqual([]);
    expect((await chatOf(teamCode)).threads[0]?.messages).toEqual([]);
  });

  it.each(["s4", "s5"] as const)(
    "%s は通常のシステムプロンプトで自分の会話へ送る",
    async (stage) => {
      const teamCode = stage === "s4" ? "610002" : "610003";
      await playTo(teamCode, stage);
      const gateway = ok();
      expect((await post(teamCode, message("質問"), gateway)).status).toBe(200);
      expect(systemOf(gateway)).toBe(systemPromptFor("default"));
      expect(systemOf(gateway)).not.toBe(systemPromptFor("s3"));
      const title = stage === "s4" ? "Stage 4" : "Stage 5";
      expect((await threadTitled(teamCode, title))?.messages).toHaveLength(2);
    },
  );

  it("Stage 3 を抜けた後は、同じ画面から送っても罠のプロンプトは付かない", async () => {
    const teamCode = "610004";
    await playTo(teamCode, "s4");
    const gateway = ok();
    await post(teamCode, message("感染対策は？"), gateway);
    expect(systemOf(gateway)).toBe(systemPromptFor("default"));
  });

  it("画面がスレッドやプロンプトを指定する本文は400で、AIを呼ばない", async () => {
    const teamCode = "610005";
    await playTo(teamCode, "s4");
    const gateway = ok();
    for (const patch of [
      { promptProfile: "s3" },
      { threadId: (await chatOf(teamCode)).threads[0]?.threadId },
    ]) {
      const response = await post(teamCode, { ...message("質問"), ...patch }, gateway);
      expect(response.status).toBe(400);
    }
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(["prologue", "s2", "s6", "final"] as const)(
    "%s ではAIへ送らない（409 no_ai_chat、AI呼び出し0回、何も保存しない）",
    async (stage) => {
      const teamCode = `6101${String(["prologue", "s2", "s6", "final"].indexOf(stage))}0`;
      await playTo(teamCode, stage);
      const before = await allMessages(teamCode);
      const gateway = ok();
      const response = await post(teamCode, message("質問"), gateway);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("no_ai_chat");
      expect(gateway.requests).toHaveLength(0);
      expect(await allMessages(teamCode)).toEqual(before);
    },
  );

  it("Stage 1 の会話（下書き以外）はAIへ送らない", async () => {
    const teamCode = "610150";
    await playTo(teamCode, "s1");
    const gateway = ok();
    const response = await post(teamCode, message("質問"), gateway);
    expect((await errorOf(response)).code).toBe("no_ai_chat");
    expect(gateway.requests).toHaveLength(0);
  });

  it("経路 POST /game/chat/messages で届く", async () => {
    const teamCode = "610160";
    await playTo(teamCode, "s2");
    const response = await postJson(`/api/teams/${teamCode}/game/chat/messages`, message("質問"));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("no_ai_chat");
  });

  it("経路からは本物のAI接続（予備への切り替えを含む）を使う。テストの宛先は届かないので503", async () => {
    const teamCode = "610170";
    await playTo(teamCode, "s4");
    const response = await postJson(`/api/teams/${teamCode}/game/chat/messages`, message("質問"));
    expect(response.status).toBe(503);
    // ユーザー発言は保存済み（同じcommandIdで再送できる）で、応答は無い。
    expect((await threadTitled(teamCode, "Stage 4"))?.messages.map((m) => m.role)).toEqual([
      "user",
    ]);
  });
});

describe("会話が用意できていないとき（Issue #85）", () => {
  it("前のステージの会話へ落とさず409 thread_not_ready。やり直した後は送れる", async () => {
    const teamCode = "620001";
    await playTo(teamCode, "s3");
    await CLEAR.s3?.(teamCode);
    // 会話のsnapshotを読めない状態で Stage 4 へ入る。
    const saved = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) =>
      String(state.storage.sql.exec("SELECT snapshot FROM chat_state").one().snapshot),
    );
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) => {
      state.storage.sql.exec("UPDATE chat_state SET snapshot = '{'");
    });
    clock.advanceBy(5_000);
    await applied(teamCode, advance("s3", "s4"));
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) => {
      state.storage.sql.exec("UPDATE chat_state SET snapshot = ?", saved);
    });
    expect(await aiOf(teamCode)).toEqual({ status: "failed" });

    const gateway = ok();
    const refused = await post(teamCode, message("質問"), gateway);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("thread_not_ready");
    expect(gateway.requests).toHaveLength(0);
    expect(await allMessages(teamCode)).toEqual([]);

    const prepared = await handlePrepareStageThread(
      new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/thread`, {
        method: "POST",
        body: JSON.stringify({ type: "prepare-stage-thread", generation: 0 }),
      }),
      env,
      teamCode,
      clock,
    );
    expect(prepared.status).toBe(200);
    expect((await post(teamCode, message("質問"), gateway)).status).toBe(200);
    expect((await threadTitled(teamCode, "Stage 4"))?.messages).toHaveLength(2);
    expect((await threadTitled(teamCode, "Stage 3"))?.messages).toEqual([]);
  });
});

describe("PIIの罠（Stage 5）", () => {
  it("他社の予備へ手で切り替えていても、氏名入りの送信は送信前に止まりAIの呼び出しは0回", async () => {
    const teamCode = "630091";
    await playTo(teamCode, "s5");
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "届いてはいけない" } }] })),
      );
    }) as typeof fetch;
    try {
      const aiGateway = createAiGateway(
        {
          OPENAI_MODEL: "gpt-4.1-mini",
          OPENAI_BASE_URL: "https://example.test/v1",
          OPENAI_API_KEY: "sk-primary-secret",
          AI_ROUTE: "fallback",
          AI_FALLBACK_BASE_URL: "https://api.anthropic.test/v1",
          AI_FALLBACK_API_KEY: "sk-ant-fallback-secret",
          AI_FALLBACK_MODEL: "claude-haiku-5-5",
        },
        new AiRouteState(),
      );
      const ctx = createExecutionContext();
      const response = await handleStageChatMessage(
        new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/chat/messages`, {
          method: "POST",
          body: JSON.stringify(message(`${PATIENT}さんの発熱を整理して`)),
        }),
        { env, ctx },
        teamCode,
        { aiGateway, nowMs: clock.now().getTime() },
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("pii_blocked");
      expect(urls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("氏名入りの送信はOpenAIを呼ばずに止め、同じ操作で罠（罰の開始）を確定する", async () => {
    const teamCode = "630001";
    await playTo(teamCode, "s5");
    const gateway = ok();
    const body = message(`${PATIENT}さんの発熱を整理して`);
    const response = await post(teamCode, body, gateway);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("pii_blocked");
    expect(gateway.requests).toHaveLength(0);
    const game = (await gameOf(teamCode)).state.game;
    expect(game.penalties.s5).toBe("in-progress");
    expect(game.stage).toBe("s5");
    // 送ろうとした本文はどこにも残らない（会話にも台帳にも）。
    expect(await allMessages(teamCode)).toEqual([]);
    const dump = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) =>
      JSON.stringify(
        ["chat_state", "processed_game_commands", "game_state", "pending_message_commands"].map(
          (table) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
        ),
      ),
    );
    expect(dump).not.toContain(PII_SURNAME);

    // 同じcommandIdの再送は、罠を二度数えない（台帳の行は1つのまま）。
    const ledger = await countRows(teamCode, "processed_game_commands");
    const again = await post(teamCode, body, gateway);
    expect(again.status).toBe(422);
    expect(await countRows(teamCode, "processed_game_commands")).toBe(ledger);
    expect(gateway.requests).toHaveLength(0);
    // 罰の最中は前進できない。
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("in-progress");
  });

  it("会話の用意に失敗していても、個人情報を送ろうとした罠は確定する", async () => {
    const teamCode = "630002";
    await playTo(teamCode, "s4");
    await CLEAR.s4?.(teamCode);
    // Stage 5 の会話だけが無い状態を作る: 入場の前に、ステージ用の枠を旧経路で上限まで埋める。
    for (
      let i = (await chatOf(teamCode)).threads.length - 1;
      i < MAX_STAGE_THREADS_PER_TEAM;
      i += 1
    ) {
      await postJson(`/api/teams/${teamCode}/chat/threads`, {
        type: "create-thread",
        commandId: crypto.randomUUID(),
        title: `埋め${String(i)}`,
        kind: "stage",
        generation: 0,
      });
    }
    clock.advanceBy(5_000);
    await applied(teamCode, advance("s4", "s5"));
    expect(await aiOf(teamCode)).toEqual({ status: "failed" });
    const gateway = ok();
    const response = await post(teamCode, message(`${PATIENT}さんの件`), gateway);
    expect(response.status).toBe(422);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("in-progress");
    expect(gateway.requests).toHaveLength(0);
  });

  it("個人情報の無い送信は罠にならずにAIへ送る", async () => {
    const teamCode = "630003";
    await playTo(teamCode, "s5");
    const gateway = ok();
    expect((await post(teamCode, message("発熱の一覧を整えて"), gateway)).status).toBe(200);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("none");
    expect(gateway.requests).toHaveLength(1);
  });

  it("Stage 3・4 の個人情報は止めるが、罠にはしない", async () => {
    const teamCode = "630004";
    await playTo(teamCode, "s3");
    const ledger = await countRows(teamCode, "processed_game_commands");
    const gateway = ok();
    const response = await post(teamCode, message(`${PATIENT}さんの件`), gateway);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("pii_blocked");
    expect(gateway.requests).toHaveLength(0);
    expect((await gameOf(teamCode)).state.game.penalties).toEqual({ s3: "none", s5: "none" });
    expect(await countRows(teamCode, "processed_game_commands")).toBe(ledger);
  });
});

/** Stage 1 を R2（AIの下書きが使えるラウンド）まで進める。 */
const toRound2 = async (teamCode: string): Promise<void> => {
  await playTo(teamCode, "s1");
  await applied(teamCode, command("s1.start"));
  clock.advanceBy(86_000);
  await applied(teamCode, command("s1.settle"));
  await applied(teamCode, command("s1.next-round"));
};

describe("Stage 1 の下書き（judgeStage1DraftRequest をサーバで確かめる）", () => {
  it("条件を満たせば、サーバが組み立てた依頼文を s1 のプロンプトでメインの会話へ送る", async () => {
    const teamCode = "640001";
    await toRound2(teamCode);
    const gateway = ok("下書きです");
    const response = await post(teamCode, draft("r1", { point: "総務課へ申請" }), gateway);
    expect(response.status).toBe(200);
    expect(chatMessageResultSchema.parse(await response.json()).assistant.text).toBe("下書きです");
    expect(systemOf(gateway)).toBe(systemPromptFor("s1"));
    const sent = gateway.requests[0]?.messages[1]?.text ?? "";
    expect(sent).toContain("次の院内メールへの返信を下書きしてください。");
    expect(sent).toContain("【受信メール】");
    expect(sent).toContain("【要点】\n総務課へ申請");
    const main = (await chatOf(teamCode)).threads[0];
    expect(main?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it.each([
    ["R1（AIの無いラウンド）", "no-ai"],
    ["材料が無い", "no-material"],
    ["着弾前のメール", "not-landed"],
    ["Stage 1 を始める前", "not-started"],
  ])("%s の下書きはAIを呼ばずに409 draft_rejected", async (name, reason) => {
    const teamCode = `6402${String(["no-ai", "no-material", "not-landed", "not-started"].indexOf(reason))}0`;
    if (reason === "not-started") await playTo(teamCode, "s1");
    else if (reason === "no-ai") {
      await playTo(teamCode, "s1");
      await applied(teamCode, command("s1.start"));
    } else await toRound2(teamCode);
    const body =
      reason === "no-ai"
        ? draft("m1", { point: "x" })
        : reason === "not-landed"
          ? draft("r2", { point: "x" })
          : draft("r1");
    const gateway = ok();
    const response = await post(teamCode, body, gateway);
    expect(response.status, name).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: "draft_rejected", reason });
    expect(gateway.requests).toHaveLength(0);
    expect(await allMessages(teamCode)).toEqual([]);
  });

  it("コンテキストが1字でも、要点より優先して参考資料としてAIへ送る（PR #266 で変更。100字の条件は廃止）", async () => {
    const teamCode = "640303";
    await toRound2(teamCode);
    const gateway = ok("下書きです");
    const response = await post(teamCode, draft("r1", { context: "引", point: "総務課" }), gateway);
    expect(response.status).toBe(200);
    const sent = gateway.requests[0]?.messages[1]?.text ?? "";
    expect(sent).toContain("【参考資料】\n引\n\n【受信メール】");
    expect(sent).toContain("【要点】\n総務課");
  });

  it("空白だけのコンテキストと空の要点はAIを呼ばずに409 draft_rejected（no-material）", async () => {
    const teamCode = "640304";
    await toRound2(teamCode);
    const gateway = ok();
    const response = await post(teamCode, draft("r1", { context: " \n\t ", point: " " }), gateway);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "draft_rejected",
      reason: "no-material",
    });
    expect(gateway.requests).toHaveLength(0);
    expect(await allMessages(teamCode)).toEqual([]);
  });

  it("Stage 1 以外では下書きさせない", async () => {
    const teamCode = "640301";
    await playTo(teamCode, "s3");
    const gateway = ok();
    const response = await post(teamCode, draft("r1", { point: "x" }), gateway);
    expect((await errorOf(response)).code).toBe("no_ai_chat");
    expect(gateway.requests).toHaveLength(0);
  });

  it("下書きの材料に個人情報があればAIを呼ばずに止める（Stage 1 は罠にしない）", async () => {
    const teamCode = "640302";
    await toRound2(teamCode);
    const gateway = ok();
    const response = await post(teamCode, draft("r1", { point: `${PATIENT}さんの件` }), gateway);
    expect(response.status).toBe(422);
    expect(gateway.requests).toHaveLength(0);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("none");
  });
});

describe("冪等・世代・レート制限", () => {
  it("同じcommandIdの再送は保存済みの結果を返し、AIを二度呼ばない。別の内容なら409", async () => {
    const teamCode = "650001";
    await playTo(teamCode, "s4");
    const gateway = ok("一度目");
    const body = message("質問");
    const first = await post(teamCode, body, gateway);
    const second = await post(teamCode, body, gateway);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(gateway.requests).toHaveLength(1);
    const conflict = await post(teamCode, { ...body, text: "別の質問" }, gateway);
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe("conflict");
    expect((await threadTitled(teamCode, "Stage 4"))?.messages).toHaveLength(2);
  });

  it("AIが失敗した送信は、ステージを進めた後に再送しても最初の会話とプロンプトのまま", async () => {
    const teamCode = "650002";
    await playTo(teamCode, "s3");
    const body = message("斑紋症の対策は？");
    const failing = new FakeAiGateway([{ kind: "failure", error: new Error("down") }]);
    expect((await post(teamCode, body, failing)).status).toBe(503);
    await CLEAR.s3?.(teamCode);
    clock.advanceBy(5_000);
    await applied(teamCode, advance("s3", "s4"));
    const gateway = ok("応答");
    expect((await post(teamCode, body, gateway)).status).toBe(200);
    expect(systemOf(gateway)).toBe(systemPromptFor("s3"));
    expect((await threadTitled(teamCode, "Stage 3"))?.messages).toHaveLength(2);
    expect((await threadTitled(teamCode, "Stage 4"))?.messages).toEqual([]);
  });

  it("GMリセットより前の世代は409で、AIも罠も動かさない", async () => {
    const teamCode = "650003";
    await playTo(teamCode, "s5");
    expect((await gmReset(teamCode)).status).toBe(200);
    const gateway = ok();
    for (const body of [message("質問"), message(`${PATIENT}さん`)]) {
      const response = await post(teamCode, body, gateway);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("stale-generation");
    }
    expect(gateway.requests).toHaveLength(0);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("none");
  });

  it("枠を超えた送信は429でAIを呼ばない。PIIの拒否も枠を使う", async () => {
    const teamCode = "650004";
    await playTo(teamCode, "s5");
    const saved = env.CHAT_RATE_LIMIT_PER_MINUTE;
    try {
      env.CHAT_RATE_LIMIT_PER_MINUTE = "2";
      const gateway = ok();
      expect((await post(teamCode, message("質問"), gateway)).status).toBe(200);
      expect((await post(teamCode, message(`${PATIENT}さん`), gateway)).status).toBe(422);
      const limited = await post(teamCode, message("もう一つ"), gateway);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).not.toBeNull();
      const limitedPii = await post(teamCode, message(`${PATIENT}さん`), gateway);
      expect(limitedPii.status).toBe(429);
      expect(gateway.requests).toHaveLength(1);
    } finally {
      env.CHAT_RATE_LIMIT_PER_MINUTE = saved;
    }
  });
});

describe("既存のチャットAPIは変わらない", () => {
  it("旧経路はゲームのステージに関係なく、画面が送ったスレッドとpromptProfileで送る", async () => {
    const teamCode = "660001";
    await playTo(teamCode, "s4");
    const main = (await chatOf(teamCode)).threads[0]?.threadId;
    const response = await postJson(`/api/teams/${teamCode}/chat/messages`, {
      type: "send-message",
      commandId: crypto.randomUUID(),
      threadId: main,
      text: `${PATIENT}さん`,
      promptProfile: "s3",
      generation: 0,
    });
    // 旧経路のPIIゲートは従来どおり422で、Stage 5 の罠には触れない。
    expect(response.status).toBe(422);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("none");
  });

  it("旧経路のスレッド作成は従来どおり使える", async () => {
    const teamCode = "660002";
    const response = await postJson(`/api/teams/${teamCode}/chat/threads`, {
      type: "create-thread",
      commandId: crypto.randomUUID(),
      title: "Stage 2",
      kind: "stage",
      generation: 0,
    });
    expect(response.status).toBe(200);
  });
});

describe("罠は会話の状態や枠に左右されない", () => {
  it("会話のsnapshotが読めなくても、Stage 5 の個人情報は罠を確定し、AIを呼ばない", async () => {
    const teamCode = "670001";
    await playTo(teamCode, "s5");
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) => {
      state.storage.sql.exec("UPDATE chat_state SET snapshot = '{'");
    });
    const gateway = ok();
    const response = await post(teamCode, message(`${PATIENT}さんの件`), gateway);
    expect(response.status).toBe(422);
    expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("in-progress");
    expect(gateway.requests).toHaveLength(0);
  });

  it("枠を使い切った後でも、Stage 5 の個人情報は罠を確定する（応答は429、AIは呼ばない）", async () => {
    const teamCode = "670002";
    await playTo(teamCode, "s5");
    const saved = env.CHAT_RATE_LIMIT_PER_MINUTE;
    try {
      env.CHAT_RATE_LIMIT_PER_MINUTE = "1";
      const gateway = ok();
      expect((await post(teamCode, message("質問"), gateway)).status).toBe(200);
      const limited = await post(teamCode, message(`${PATIENT}さんの件`), gateway);
      expect(limited.status).toBe(429);
      expect((await gameOf(teamCode)).state.game.penalties.s5).toBe("in-progress");
      expect(gateway.requests).toHaveLength(1);
    } finally {
      env.CHAT_RATE_LIMIT_PER_MINUTE = saved;
    }
  });
});
