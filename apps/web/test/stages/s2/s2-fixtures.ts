import { gameViewResponseSchema } from "@hell-ict/domain";
import type { Stage2State } from "@hell-ict/domain";
import { nextTick, ref } from "vue";

import type { GameView } from "../../../src/composables/use-game-session.js";
import type { SfxName } from "../../../src/composables/use-sfx.js";
import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import type { StageContext } from "../../../src/stages/stage-module.js";
import { FakeKeyValueStorage, FakeScheduler, flush, viewBody } from "../../fakes.js";
import { fakeSession, T0 } from "../s1/fake-session.js";
import type { Answer } from "../s1/fake-session.js";

export { T0 };

/** The view of a team in Stage 2 with this state (`cleared`: the judge has passed it). */
export const s2View = (s2: Stage2State | null, options: { cleared?: boolean } = {}): GameView => {
  const body = viewBody(3);
  const at = new Date(T0).toISOString();
  return gameViewResponseSchema.parse({
    ...body,
    state: {
      ...body.state,
      game: {
        ...body.state.game,
        stage: "s2",
        clearedAt: { prologue: at, s1: at, ...(options.cleared === true ? { s2: at } : {}) },
      },
      enteredAt: { s1: at, s2: at },
      s2,
    },
  });
};

/** A stage context on a fake session that answers with `answer`; the sounds played are kept. */
export const s2Context = (
  initial: GameView | null,
  answer: Answer = () => ({ kind: "failed" }),
  options: { now?: number; storage?: FakeKeyValueStorage } = {},
) => {
  const fake = fakeSession(initial, answer);
  const serverNow = ref(options.now ?? T0 + 1_000);
  const scheduler = new FakeScheduler();
  const storage = options.storage ?? new FakeKeyValueStorage();
  const sounds: SfxName[] = [];
  const context: StageContext = {
    session: fake.session,
    serverNow,
    sessionStorage: storage,
    scheduler,
    mail: useMailSelection(),
    sfx: {
      play: (name) => {
        sounds.push(name);
      },
    },
    karubeRead: ref(new Set<string>()),
    teamName: ref(""),
  };
  return { ...fake, context, serverNow, scheduler, storage, sounds };
};

export const settle = async (): Promise<void> => {
  await nextTick();
  await flush();
};
