import { stage1FirstFailureCause, stage1SettleAt } from "@hell-ict/domain";
import type { Stage1MailId, Stage1State } from "@hell-ict/domain";
import { computed, shallowRef, watch } from "vue";
import type { ComputedRef } from "vue";
import { z } from "zod";

import { useAtServerTime } from "../../composables/use-at-server-time.js";
import type { ServerMoment } from "../../composables/use-at-server-time.js";
import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import type { KarubeCall, StageContext } from "../stage-module.js";
import { stage1KarubeCalls } from "./karube-calls.js";
import type { Stage1FirstFailureCause } from "./karube-calls.js";
import {
  stage1CanOpen,
  stage1LandedKeys,
  stage1NewLandings,
  stage1Rows,
  STAGE1_MEMO_ROW_ID,
} from "./s1-view.js";
import type { Stage1Row } from "./s1-view.js";

/**
 * What pressing a Stage 1 button came to.
 * - empty: the text was blank; nothing was sent (the button says 「本文が空です」).
 * - closed: nothing to send it to now (the mail is not live, the round is over, the same
 *   command is already on its way); nothing was sent.
 * - sent: the server's answer (or why there was none). The state it brought is on screen.
 */
export type Stage1Press =
  | { readonly kind: "empty" | "closed" }
  | { readonly kind: "sent"; readonly outcome: SendOutcome };

export interface Stage1 {
  /** `null` until [了解しました] starts the stage. */
  readonly state: ComputedRef<Stage1State | null>;
  readonly rows: ComputedRef<readonly Stage1Row[]>;
  /** 苅部さん's calls that should have rung by now, oldest first (`stage1KarubeCalls`). */
  readonly karubeCalls: ComputedRef<readonly KarubeCall[]>;
  /** [了解しました] of the briefing: starts the clock (`s1.start`). */
  start(): Promise<Stage1Press>;
  reply(mailId: Stage1MailId, text: string): Promise<Stage1Press>;
  replyToMemo(text: string): Promise<Stage1Press>;
  /** The button of a failed round's result window (`s1.next-round`). */
  nextRound(): Promise<Stage1Press>;
}

/** Waits before asking again for a settle the server found early (its clock is the judge). */
export const STAGE1_SETTLE_RETRY_MS = 1_000;
/** A settle is asked for at most this many times per round. */
export const STAGE1_SETTLE_MAX_TRIES = 10;

const causeSchema = z
  .object({ stageStartedAt: z.number(), cause: z.enum(["curt", "missed"]) })
  .strict();

type CauseRecord = z.infer<typeof causeSchema>;

const CLOSED: Stage1Press = { kind: "closed" };
const EMPTY: Stage1Press = { kind: "empty" };

/**
 * What made the ended R1 fail, from the state alone. The server ended the round, so every mail
 * not answered had missed by then; judging at the moment the round's own schedule settles it
 * (never the screen's estimate of the server's clock, which may lag behind) counts them so.
 */
const roundOneCause = (s1: Stage1State): Stage1FirstFailureCause => {
  const settledAt = stage1SettleAt({ ...s1, status: { phase: "playing" } });
  return settledAt === null ? "missed" : stage1FirstFailureCause(s1, settledAt);
};

/** The settle went through, or the round is not this screen's to settle any more. */
const settleIsOver = (outcome: SendOutcome): boolean => {
  if (outcome.kind !== "done") return outcome.kind !== "unavailable" && outcome.kind !== "failed";
  const { response } = outcome;
  return response.status !== "rejected" || response.reason !== "round-not-over";
};

/**
 * Stage 1's state and buttons. The server keeps the truth; this sends the commands, never twice
 * at once, and reports the round's end on the server's clock (`s1.settle`, `GET /game` does not
 * judge). R1's cause is kept in sessionStorage when its result window comes up, since the state
 * forgets it once R2 starts and 苅部さん's first words depend on it.
 */
export const useStage1 = (context: StageContext): Stage1 => {
  const { session, serverNow, scheduler } = context;
  const inFlight = new Set<string>();
  const state = computed(() =>
    session.view.value?.state.game.stage === "s1" ? session.view.value.state.s1 : null,
  );
  const rows = computed(() =>
    state.value === null ? [] : stage1Rows(state.value, serverNow.value),
  );

  const causeRecord = () => {
    const code = session.teamCode.value;
    if (code === null) return null;
    const key = sessionRecordKey("Stage1Cause", code);
    return sessionRecord(context.sessionStorage, key, causeSchema);
  };
  const cause = shallowRef<CauseRecord | null>(causeRecord()?.read() ?? null);
  const karubeCalls = computed((): readonly KarubeCall[] => {
    const s1 = state.value;
    if (s1 === null) return [];
    const known = cause.value?.stageStartedAt === s1.stageStartedAt ? cause.value.cause : null;
    return stage1KarubeCalls(s1, known);
  });

  // R1's result window is up: record what made it fail, once per stage.
  watch(
    state,
    (s1) => {
      if (s1?.status.phase !== "round-result" || s1.round !== 1) return;
      if (cause.value?.stageStartedAt === s1.stageStartedAt) return;
      const next = { stageStartedAt: s1.stageStartedAt, cause: roundOneCause(s1) };
      cause.value = next;
      causeRecord()?.write(next);
    },
    { immediate: true },
  );

  /** Sends a command unless the same one is still on its way. */
  const send = async (key: string, command: GameCommandInput): Promise<Stage1Press> => {
    if (inFlight.has(key)) return CLOSED;
    inFlight.add(key);
    try {
      return { kind: "sent", outcome: await session.send(command) };
    } finally {
      inFlight.delete(key);
    }
  };

  // Each try of each round is its own moment: a settle the server found early (the screen's
  // estimate of the server's clock ran ahead) is asked again a little later.
  const settleTry = shallowRef(0);
  const settleMoment = (): ServerMoment | null => {
    const s1 = state.value;
    const at = s1 === null ? null : stage1SettleAt(s1);
    if (s1 === null || at === null || settleTry.value >= STAGE1_SETTLE_MAX_TRIES) return null;
    return { key: `${String(s1.roundStartedAt)}:${String(settleTry.value)}`, at };
  };
  useAtServerTime(serverNow, settleMoment, (key) => {
    void send("settle", { type: "s1.settle" }).then((press) => {
      if (press.kind !== "sent" || settleIsOver(press.outcome)) return;
      scheduler.schedule(() => {
        if (settleMoment()?.key === key) settleTry.value += 1;
      }, STAGE1_SETTLE_RETRY_MS);
    });
  });
  // A new round starts its own count.
  watch(
    () => state.value?.roundStartedAt,
    () => {
      settleTry.value = 0;
    },
  );

  // Each mail chimes once as it lands (mock s1Land); a clock set back and forward again does not
  // chime it twice. What had landed when this screen came up (a reload) stays quiet: a one-off
  // moment is not played again. That is read at the first redraw of the server's time, not at
  // once: after a reload the stage is built before the offset to the server is learnt, and the
  // time read then is the PC's own. Before the start nothing has landed, whatever the clock.
  const landedNow = (): readonly string[] => stage1LandedKeys(state.value, serverNow.value);
  let heard: Set<string> | null =
    session.view.value !== null && state.value === null ? new Set() : null;
  // Registered before the chime's watcher, so it runs first on the same redraw.
  watch(serverNow, () => {
    heard ??= new Set(landedNow());
  });
  watch(landedNow, (after) => {
    for (const key of stage1NewLandings(heard, after)) {
      heard?.add(key);
      context.sfx.play("decision1");
    }
  });

  const playing = (): boolean => state.value?.status.phase === "playing";

  return {
    state,
    rows,
    karubeCalls,
    start: () =>
      session.view.value?.state.game.stage === "s1" && state.value === null
        ? send("start", { type: "s1.start" })
        : Promise.resolve(CLOSED),
    reply: (mailId, text) => {
      if (text.trim() === "") return Promise.resolve(EMPTY);
      if (!playing() || !stage1CanOpen(rows.value, mailId)) return Promise.resolve(CLOSED);
      return send(`reply:${mailId}`, { type: "s1.reply", mailId, text });
    },
    replyToMemo: (text) => {
      if (text.trim() === "") return Promise.resolve(EMPTY);
      if (!playing() || !stage1CanOpen(rows.value, STAGE1_MEMO_ROW_ID)) {
        return Promise.resolve(CLOSED);
      }
      return send("memo", { type: "s1.memo-reply", text });
    },
    nextRound: () =>
      state.value?.status.phase === "round-result"
        ? send("next-round", { type: "s1.next-round" })
        : Promise.resolve(CLOSED),
  };
};
