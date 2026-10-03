import { stageEntryBands } from "@hell-ict/content";
import { teamGameScene } from "@hell-ict/domain";
import { FakeClock, FakeIdGenerator } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";
import { computed, effectScope } from "vue";

import { createGameApi } from "../src/api/game-api.js";
import {
  CLEAR_GRACE_MS,
  CLEAR_UNLOCK_MS,
  useClearSequence,
} from "../src/composables/use-clear-sequence.js";
import { createGameSession } from "../src/composables/use-game-session.js";
import { useRedBand } from "../src/composables/use-red-band.js";
import type { HttpRequest, HttpResponse } from "../src/ports.js";
import {
  FakeHttp,
  FakeKeyValueStorage,
  FakeResumeSignal,
  FakeScheduler,
  flush,
  ok,
  sessionBody,
  START_MS,
  unavailable,
  viewBody,
} from "./fakes.js";

const IDS = Array.from(
  { length: 20 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);
const AT = new Date(START_MS).toISOString();

/** The body of `GET /game` for a team on `stage`, cleared or not. */
const teamView = (stage: "s2" | "s3", cleared: boolean) => {
  const body = viewBody(stage === "s2" ? 2 : 3);
  const behind = stage === "s2" ? ["prologue", "s1"] : ["prologue", "s1", "s2"];
  const clearedIds = cleared ? [...behind, stage] : behind;
  return {
    ...body,
    state: {
      ...body.state,
      game: {
        ...body.state.game,
        stage,
        clearedAt: Object.fromEntries(clearedIds.map((id) => [id, AT])),
      },
      enteredAt: Object.fromEntries(
        (stage === "s2" ? ["s1", "s2"] : ["s1", "s2", "s3"]).map((id) => [id, AT]),
      ),
    },
  };
};

const commandIdOf = (request: HttpRequest): string => {
  const body = request.body;
  return typeof body === "object" && body !== null && "commandId" in body
    ? String(body.commandId)
    : "";
};

/**
 * The server applies the first `advance` but its answer never arrives (every try of it ends in
 * a 503 here). A later `advance` under the same commandId is a `duplicate` with the events of the
 * first application; under another id it is refused as `stage-mismatch`, as the Worker does.
 */
class LostAnswerServer {
  applied: string | null = null;
  losing = true;

  handle = (request: HttpRequest): HttpResponse => {
    if (request.path === "/api/session") return ok(sessionBody("123456", 3));
    if (request.path.endsWith("/game"))
      return ok(teamView(this.applied ? "s3" : "s2", !this.applied));
    const id = commandIdOf(request);
    if (this.losing) {
      this.applied ??= id;
      return unavailable();
    }
    const entered = [{ type: "stage-entered", stage: "s3", at: AT }];
    if (id === this.applied) {
      return ok({
        status: "duplicate",
        original: { events: entered, judgement: null },
        ...teamView("s3", false),
      });
    }
    return ok({
      status: "rejected",
      reason: "stage-mismatch",
      judgement: null,
      ...teamView("s3", false),
    });
  };
}

describe("クリア演出の advance：応答が失われた後の押し直し", () => {
  it("同じ commandId で送り直し、duplicate が運ぶ最初の出来事で入場の赤帯を出す", async () => {
    const server = new LostAnswerServer();
    const http = new FakeHttp(server.handle);
    const scheduler = new FakeScheduler();
    const scope = effectScope();
    const wired = scope.run(() => {
      const session = createGameSession({
        api: createGameApi(http),
        clock: new FakeClock(new Date(START_MS)),
        ids: new FakeIdGenerator(IDS),
        storage: new FakeKeyValueStorage(),
        scheduler,
        resume: new FakeResumeSignal(),
      });
      const scene = computed(() =>
        session.view.value === null ? null : teamGameScene(session.view.value.state),
      );
      const clear = useClearSequence({
        scene,
        scheduler,
        onUnlock: () => undefined,
        newCommandId: () => session.newCommandId(),
        sendAdvance: (from, to, commandId) =>
          session.send({ type: "advance", from, to }, commandId),
      });
      const band = useRedBand({
        scheduler,
        subscribe: (listener) => session.onEvents(listener),
        onShow: () => undefined,
      });
      return { session, clear, band };
    });
    if (wired === undefined) throw new Error("scope did not run");
    const { session, clear, band } = wired;

    await session.join("123456");
    expect(clear.step.value).toBe("unlock");
    scheduler.advanceBy(CLEAR_UNLOCK_MS);
    clear.next();
    scheduler.advanceBy(CLEAR_GRACE_MS);
    clear.next();
    expect(clear.step.value).toBe("handover");
    scheduler.advanceBy(CLEAR_GRACE_MS);
    clear.next();
    // Every try of the first send ends in a 503: the screen gives up (unavailable).
    for (let round = 0; round < 10; round += 1) {
      await flush();
      scheduler.advanceBy(10_000);
    }
    await flush();
    expect(clear.sending.value).toBe(false);
    expect(band.phase.value).toBe("hidden");

    server.losing = false;
    clear.next();
    await flush();
    await flush();

    const advances = http.to("/game/commands");
    expect(new Set(advances.map(commandIdOf)).size).toBe(1);
    expect(band.phase.value).toBe("in");
    expect(band.text.value).toBe(stageEntryBands.s3);
    expect(session.view.value?.state.game.stage).toBe("s3");
    scope.stop();
  });
});
