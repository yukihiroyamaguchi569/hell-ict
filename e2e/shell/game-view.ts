import {
  GAME_STAGE_IDS,
  gameStagePosition,
  gameViewResponseSchema,
  type GameStageId,
} from "../../packages/domain/src/index.js";

/*
 * `GET /api/teams/:code/game` の固定応答。ステージの中身がまだ無い画面を、任意のステージの
 * 状態から始めるために使う。画面と同じ schema に通してから返す。
 */

/**
 * How long ago (by the time the fake game is set up) the team accepted Stage 1's briefing, which
 * starts the race clock, and started Stage 2, which starts its five-minute deadline. Relative to
 * the time the test runs, so the header clock shows a positive time that keeps going.
 */
const RACE_STARTED_AGO_MS = 90_000;
const S2_STARTED_AGO_MS = 60_000;

/**
 * The fake server's clock runs this far ahead of the browser's. Every time in the state is the
 * server's, so the header clock and the countdown only come out right if the screen corrects
 * for the gap from `serverNow` (uncorrected, the race clock would be negative and the deadline
 * ten minutes further away).
 */
const SERVER_AHEAD_MS = 10 * 60_000;
export const serverNow = (): number => Date.now() + SERVER_AHEAD_MS;

export const PLAYED = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

/**
 * A team on `stage`, with every stage behind it cleared as the server writes it. `base` is the
 * server's time when the fake game was set up.
 */
const teamState = (stage: GameStageId, cleared: boolean, base: number) => {
  const at = (minutes: number): string =>
    new Date(base - 30 * 60_000 + minutes * 60_000).toISOString();
  const raceStart = base - RACE_STARTED_AGO_MS;
  const position = gameStagePosition(stage);
  const behind = GAME_STAGE_IDS.filter(
    (id) => id !== "final" && (gameStagePosition(id) < position || (cleared && id === stage)),
  );
  const entered = PLAYED.filter((id) => gameStagePosition(id) <= position);
  const s1Cleared = behind.includes("s1");
  return {
    game: {
      stage,
      clearedAt: Object.fromEntries(behind.map((id, i) => [id, at(i + 1)])),
      penalties: { s3: position > gameStagePosition("s3") ? "done" : "none", s5: "none" },
    },
    startedAt: at(0),
    enteredAt: Object.fromEntries(entered.map((id, i) => [id, at(i + 1)])),
    inbox: { openedAt: raceStart - 5 * 60_000, sent: ["p0", "p1", "p2"] },
    s1: {
      stageStartedAt: raceStart,
      round: 1,
      roundStartedAt: raceStart,
      r3Try: 0,
      doneIds: s1Cleared ? ["m1", "m2", "m3", "m4", "m8"] : [],
      curt: [],
      memoReplied: false,
      status: s1Cleared ? { phase: "cleared", result: "manual" } : { phase: "playing" },
    },
    s2:
      position >= gameStagePosition("s2")
        ? { startedAt: base - S2_STARTED_AGO_MS, addendumTakenAt: null }
        : null,
    s3: { trapJudgements: position > gameStagePosition("s3") ? 1 : 0 },
    s4: { summaryAccepted: false },
    s6: { promptLog: [], candidates: [] },
  };
};

/** `GET /game`'s body, checked by the same schema the screen checks it with. */
export const gameView = (stage: GameStageId, cleared: boolean, base: number) => {
  const state = teamState(stage, cleared, base);
  return gameViewResponseSchema.parse({
    state,
    pos: gameStagePosition(stage) + (cleared ? 1 : 0),
    serverNow: serverNow(),
    ai: { status: "none" },
  });
};
