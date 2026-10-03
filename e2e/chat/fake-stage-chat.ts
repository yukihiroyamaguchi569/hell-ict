import type { Page, Request, Route } from "@playwright/test";

import {
  chatSnapshotSchema,
  gameViewResponseSchema,
  type StageAi,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";
import { SAVED_TEAM_CODE_KEY } from "../shell/helpers";

/*
 * Stage 3 の右ペインを、固定の応答で動かす道具。入室（/api/session）と疎通確認は本物の
 * Worker、`GET /game`・`GET /chat`・`POST .../game/chat/messages`・`POST .../game/chat/thread`
 * は page.route で差し替える。応答はどれも画面と同じ schema に通してから返す。
 */

export const S2 = "22222222-2222-4222-8222-222222222222";
export const S3 = "33333333-3333-4333-8333-333333333333";
export const S4 = "44444444-4444-4444-8444-444444444444";

type MessageRole = "user" | "assistant";

export interface FakeMessage {
  readonly messageId: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: string;
}

/** Answers a message's POST (a test may hold it to keep the message in flight). */
type Answer = (route: Route, body: Record<string, unknown>) => Promise<void>;

export interface FakeStageChat {
  /** The stage AI `GET /game` names. */
  ai: StageAi;
  /** The threads `GET /chat` answers with, in order. */
  threads: Record<string, FakeMessage[]>;
  revision: number;
  /** Where each asked id stands (`GET /chat?commandIds=`); an id not listed is `unknown`. */
  commands: Record<string, "pending" | "processed" | "unknown">;
  /** Every `POST .../game/chat/messages` body, in order. */
  readonly posts: Record<string, unknown>[];
  /** Every `GET /chat` URL, in order. */
  readonly chatGets: string[];
  /** Every `POST .../game/chat/thread`. */
  readonly prepares: Record<string, unknown>[];
  /** How the next message is answered. By default the AI replies `回答: <text>`. */
  answer: Answer;
  /** How the next prepare is answered. By default the stage's conversation is ready. */
  prepare: (() => StageAi) | null;
  /** Stores the text and a reply in the current thread, and answers 200. */
  readonly reply: (text: string, replyText?: string) => unknown;
}

let messageSeq = 0;

export const message = (role: MessageRole, text: string): FakeMessage => {
  messageSeq += 1;
  return {
    messageId: `00000000-0000-4000-9000-${String(messageSeq).padStart(12, "0")}`,
    role,
    text,
    createdAt: new Date(Date.UTC(2026, 9, 31, 1, 0, messageSeq)).toISOString(),
  };
};

const bodyOf = (request: Request): Record<string, unknown> => {
  const body: unknown = request.postDataJSON();
  return typeof body === "object" && body !== null ? { ...body } : {};
};

const isChatGet = (url: URL): boolean => /^\/api\/teams\/\d{6}\/chat$/.test(url.pathname);

/**
 * Serves the pane's routes for `teamCode` from the returned object, which the test changes
 * as it goes. The screen restores `teamCode` from localStorage, as after a reload.
 */
export const fakeStageChat = async (page: Page, teamCode: string): Promise<FakeStageChat> => {
  const base = serverNow();
  const snapshot = (commandIds: string | null) =>
    chatSnapshotSchema.parse({
      teamCode,
      revision: fake.revision,
      threads: Object.entries(fake.threads).map(([threadId, messages], index) => ({
        threadId,
        title: `Stage ${String(index + 2)}`,
        kind: "stage",
        messages,
      })),
      ...(commandIds === null
        ? {}
        : {
            commands: Object.fromEntries(
              commandIds.split(",").map((id) => [id, fake.commands[id] ?? "unknown"]),
            ),
          }),
    });
  // A team in Stage 3, not cleared yet (Prologue to Stage 2 behind it).
  const view = () =>
    gameViewResponseSchema.parse({
      ...gameView("s3", false, base),
      serverNow: serverNow(),
      ai: fake.ai,
    });
  const currentThread = (): string => (fake.ai.status === "ready" ? fake.ai.threadId : S3);

  const fake: FakeStageChat = {
    ai: { status: "ready", threadId: S3, live: true },
    threads: { [S2]: [message("user", "前のステージの質問")], [S3]: [] },
    revision: 1,
    commands: {},
    posts: [],
    chatGets: [],
    prepares: [],
    answer: async (route, body) => {
      await route.fulfill({ json: fake.reply(String(body.text)) });
    },
    prepare: null,
    reply: (text, replyText = `回答: ${text}`) => {
      const assistant = message("assistant", replyText);
      const threadId = currentThread();
      fake.threads[threadId] = [
        ...(fake.threads[threadId] ?? []),
        message("user", text),
        assistant,
      ];
      fake.revision += 1;
      return { snapshot: snapshot(null), assistant };
    },
  };

  await page.addInitScript(
    ([key, code]) => {
      localStorage.setItem(key, code);
      // Stage 3's notice from the nursing director has been read: it would cover the chat.
      sessionStorage.setItem(`hellVueS3Notice:${code}`, "true");
    },
    [SAVED_TEAM_CODE_KEY, teamCode] as const,
  );
  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: view() });
  });
  await page.route(isChatGet, async (route) => {
    const url = new URL(route.request().url());
    fake.chatGets.push(url.pathname + url.search);
    await route.fulfill({ json: snapshot(url.searchParams.get("commandIds")) });
  });
  await page.route("**/api/teams/*/game/chat/messages", async (route) => {
    const body = bodyOf(route.request());
    fake.posts.push(body);
    await fake.answer(route, body);
  });
  await page.route("**/api/teams/*/game/chat/thread", async (route) => {
    fake.prepares.push(bodyOf(route.request()));
    if (fake.prepare !== null) fake.ai = fake.prepare();
    await route.fulfill({ json: view() });
  });
  return fake;
};

/** A refusal in the Worker's `{message, code?}` form. */
export const refuse = async (
  route: Route,
  status: number,
  body: { message: string; code?: string },
  headers: Record<string, string> = {},
): Promise<void> => {
  await route.fulfill({ status, json: body, headers });
};
