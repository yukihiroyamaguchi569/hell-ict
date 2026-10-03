import type { Page } from "@playwright/test";

import {
  gameCommandResponseSchema,
  gameInstantSchema,
  gameStagePosition,
  gameViewResponseSchema,
  judgeStage3,
  stage3SubmissionSchema,
} from "../../packages/domain/src/index.js";
import { gameView, serverNow } from "../shell/game-view";

/*
 * Stage 3 のチームを受け持つ偽のサーバ。`GET /game` と `POST /game/commands` を page.route で差し替え、
 * 提出は domain の judgeStage3 で本物と同じに判定する。罠は初回だけ罰を始め（trap-triggered）、
 * 2回目以降は trap-repeated。受け付けるのは罰の外の s3.submit、罰の間の s3.finish-penalty、S3 にいてクリア済みの
 * ときの advance {s3→s4} だけで（advance の後は s4 にいるので、別の commandId の advance は想定外）、
 * それ以外は `unexpected` に残して 500 を返す。
 */

export interface FakeStage3 {
  /** Every command the screen posted, in order. */
  readonly commands: { type: string }[];
  /** Commands the screen should never have sent at that moment (answered 500). Must stay empty. */
  readonly unexpected: unknown[];
  count(type: string): number;
  /** Keeps the next `s3.submit` unanswered until the returned function is called. */
  holdNextSubmit(): () => void;
}

type View = ReturnType<typeof gameView>;
type Event = "stage-cleared" | "submission-rejected" | "trap-triggered" | "trap-repeated";

const at = () => gameInstantSchema.parse(new Date(serverNow()).toISOString());

const withState = (view: View, change: (state: View["state"]) => View["state"]): View =>
  gameViewResponseSchema.parse({ ...view, state: change(view.state) });

const commandType = (body: unknown): string =>
  typeof body === "object" && body !== null && "type" in body ? String(body.type) : "";

const commandId = (body: unknown): string =>
  typeof body === "object" && body !== null && "commandId" in body ? String(body.commandId) : "";

const isAdvanceFromS3 = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  "from" in body &&
  "to" in body &&
  body.from === "s3" &&
  body.to === "s4";

const submissionOf = (body: unknown) =>
  stage3SubmissionSchema.parse(
    typeof body === "object" && body !== null && "submission" in body ? body.submission : null,
  );

export const fakeStage3 = async (page: Page): Promise<FakeStage3> => {
  let view = gameView("s3", false, serverNow());
  const commands: { type: string }[] = [];
  const unexpected: unknown[] = [];

  const answer = (events: Event[], judgement: unknown) =>
    gameCommandResponseSchema.parse({
      status: "applied",
      events: events.map((type) => ({ type, stage: "s3", at: at() })),
      judgement,
      ...view,
      serverNow: serverNow(),
    });
  const setPenalty = (s3: "in-progress" | "done", trapJudgements: number): void => {
    view = withState(view, (state) => ({
      ...state,
      game: { ...state.game, penalties: { ...state.game.penalties, s3 } },
      s3: { trapJudgements },
    }));
  };

  const submit = (body: unknown) => {
    const { penalties } = view.state.game;
    const judgement = judgeStage3(submissionOf(body));
    if (judgement.outcome === "reject") return answer(["submission-rejected"], judgement);
    if (judgement.outcome === "trap") {
      const first = penalties.s3 === "none";
      setPenalty(first ? "in-progress" : "done", view.state.s3.trapJudgements + 1);
      return answer([first ? "trap-triggered" : "trap-repeated"], judgement);
    }
    view = gameViewResponseSchema.parse({
      ...withState(view, (state) => ({
        ...state,
        game: { ...state.game, clearedAt: { ...state.game.clearedAt, s3: at() } },
      })),
      pos: gameStagePosition("s3") + 1,
    });
    return answer(["stage-cleared"], judgement);
  };

  const finish = () => {
    setPenalty("done", view.state.s3.trapJudgements);
    return answer([], null);
  };

  const advance = () => {
    view = gameView("s4", false, serverNow());
    return gameCommandResponseSchema.parse({
      status: "applied",
      events: [{ type: "stage-entered", stage: "s4", at: at() }],
      judgement: null,
      ...view,
      serverNow: serverNow(),
    });
  };

  /** Whether the screen may send `type` now (the Worker would accept it). */
  const expected = (type: string, body: unknown): boolean => {
    const { penalties, clearedAt, stage } = view.state.game;
    const cleared = clearedAt.s3 !== undefined;
    if (type === "s3.submit") return stage === "s3" && !cleared && penalties.s3 !== "in-progress";
    if (type === "s3.finish-penalty") return penalties.s3 === "in-progress";
    return type === "advance" && stage === "s3" && cleared && isAdvanceFromS3(body);
  };

  /** The answer to a command the screen may send now, or `null` for one it never should. */
  const handle = (body: unknown) => {
    const type = commandType(body);
    if (!expected(type, body)) return null;
    if (type === "s3.submit") return submit(body);
    return type === "s3.finish-penalty" ? finish() : advance();
  };

  let hold: Promise<void> | null = null;
  /** What each applied command did, by commandId, for resends. */
  const answered = new Map<string, { events: unknown; judgement: unknown }>();
  const duplicate = (original: { events: unknown; judgement: unknown }) =>
    gameCommandResponseSchema.parse({
      status: "duplicate",
      original,
      ...view,
      serverNow: serverNow(),
    });

  await page.route("**/api/teams/*/game", async (route) => {
    await route.fulfill({ json: { ...view, serverNow: serverNow() } });
  });
  await page.route("**/api/teams/*/game/commands", async (route) => {
    const body: unknown = route.request().postDataJSON();
    commands.push({ type: commandType(body) });
    if (commandType(body) === "s3.submit" && hold !== null) {
      await hold;
      hold = null;
    }
    const id = commandId(body);
    const first = answered.get(id);
    if (first !== undefined) {
      // A resend of an applied command: the Worker answers `duplicate` and applies nothing.
      await route.fulfill({ json: duplicate(first) });
      return;
    }
    const json = handle(body);
    if (json === null) {
      unexpected.push(body);
      await route.fulfill({ status: 500, json: { error: "unexpected command" } });
      return;
    }
    if (json.status === "applied")
      answered.set(id, { events: json.events, judgement: json.judgement });
    await route.fulfill({ json });
  });

  return {
    commands,
    unexpected,
    count: (type) => commands.filter((c) => c.type === type).length,
    holdNextSubmit: () => {
      let release: () => void = () => undefined;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        release();
      };
    },
  };
};
