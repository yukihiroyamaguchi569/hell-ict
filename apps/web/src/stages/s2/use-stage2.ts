import {
  isStage2AddendumTaken,
  readStage2TableForGrid,
  stage2DeadlineAt,
  stage2ExpectedRowCount,
  stage2GridSchema,
} from "@hell-ict/domain";
import type { Stage2Grid, Stage2State } from "@hell-ict/domain";
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { z } from "zod";

import { useAtServerTime } from "../../composables/use-at-server-time.js";
import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import type { Verdict } from "../../verdict/verdict.js";
import { verdictTicks } from "../../verdict/verdict-ticks.js";
import type { InboxRow, StageContext } from "../stage-module.js";
import { stage2PasteErrorText } from "./s2-ai.js";
import {
  stage2AddendumGridRows,
  stage2CanTake,
  stage2FreshGrid,
  stage2InboxRows,
  stage2SubmitResult,
  withCell,
  withEmptyRow,
  withoutCell,
  withoutRow,
} from "./s2-view.js";

export interface Stage2 {
  /** `null` until `s2.start` has gone through. */
  readonly state: ComputedRef<Stage2State | null>;
  readonly cleared: ComputedRef<boolean>;
  readonly grid: Readonly<Ref<Stage2Grid>>;
  /** The cells the last rejection pointed at, as `cellKey`s. */
  readonly hot: Readonly<Ref<ReadonlySet<string>>>;
  /** The verdict under the folded form, or `null` while the grid is out for editing. */
  readonly verdict: Readonly<Ref<Verdict | null>>;
  readonly inboxRows: ComputedRef<readonly InboxRow[]>;
  /** ［表に追加］ is offered in the addendum's viewer. */
  readonly canTake: ComputedRef<boolean>;
  edit(row: number, column: number, value: string): void;
  addRow(): void;
  deleteRow(row: number): void;
  /** ［最初の状態に戻す］ (the component asks first). */
  reset(): void;
  submit(): Promise<void>;
  /** ［表に追加］: `s2.take-addendum`. The rows go in when the state says it was taken. */
  take(): Promise<void>;
  /** ［提出に戻る］ after a rejection. */
  reopen(): void;
  /** Why the last table sent or pasted did not go in (mock `#paste-bar`), or `null`. */
  readonly pasteError: Readonly<Ref<string | null>>;
  /** Counts the tables that went in: the grid flashes and comes into view on each. */
  readonly landed: Readonly<Ref<number>>;
  /**
   * ［表に送る］ and a paste of several lines (mock s2SendTableToGrid): a table replaces the grid
   * at once, anything else is refused with its reason and changes nothing.
   */
  sendTable(text: string): void;
  /**
   * Holds back the clear effect (`StageInstance.pauseClear`): while a submission is being judged
   * (its answer may be the clear), and for STAGE2_PASS_HOLD_MS after a pass, while its checks
   * tick in. Never on a reload into a cleared stage: no verdict is on screen then.
   */
  readonly pauseClear: ComputedRef<boolean>;
}

/** Waits before asking again to start the stage when the first `s2.start` got no answer. */
export const STAGE2_START_RETRY_MS = 2_000;
/**
 * The addendum's arrival sound plays only this soon after the deadline: a screen that comes up
 * later (a reload) finds it landed already, and a one-off effect is not replayed (V1 decision F).
 */
export const STAGE2_LANDING_SOUND_MS = 1_000;
/**
 * How long a pass keeps the clear effect back: VerdictBox brings in the four checks and the line
 * of success by animation-delay (the last at 1.8 s, faded in by 2.1 s), and a beat to read it.
 */
export const STAGE2_PASS_HOLD_MS = 2_400;

/** The grid kept for a reload: whose start of the stage it belongs to, and whether it has the addendum. */
const gridRecordSchema = z
  .object({ startedAt: z.number(), grid: stage2GridSchema, addendumIn: z.boolean() })
  .strict();

const CHECKING: Verdict = { kind: "checking" };
const NO_CELLS: ReadonlySet<string> = new Set();

const needsStart = (outcome: SendOutcome): boolean =>
  outcome.kind === "unavailable" || outcome.kind === "failed";

/**
 * Stage 2 by hand. The server keeps the stage's clock and judges the grid; the grid itself
 * lives on this screen and in sessionStorage (`hellVueGrid:<code>`, tied to the stage's
 * `startedAt` so a team reset by the game master starts from the sheet again).
 */
export const useStage2 = (context: StageContext): Stage2 => {
  const { session, serverNow, scheduler } = context;
  const inFlight = new Set<string>();
  const game = computed(() => session.view.value?.state ?? null);
  const state = computed(() => (game.value?.game.stage === "s2" ? game.value.s2 : null));
  const cleared = computed(() => game.value?.game.clearedAt.s2 !== undefined);

  const grid = shallowRef<Stage2Grid>([]);
  const hot = shallowRef<ReadonlySet<string>>(NO_CELLS);
  const verdict = shallowRef<Verdict | null>(null);
  const pasteError = shallowRef<string | null>(null);
  const landed = shallowRef(0);
  let startedAt: number | null = null;
  let addendumIn = false;

  const record = () => {
    const code = session.teamCode.value;
    if (code === null) return null;
    return sessionRecord(context.sessionStorage, sessionRecordKey("Grid", code), gridRecordSchema);
  };
  const setGrid = (next: Stage2Grid): void => {
    grid.value = next;
    if (startedAt !== null) record()?.write({ startedAt, grid: next, addendumIn });
  };

  /** Sends a command unless the same one is still on its way (`null`: not sent). */
  const send = async (key: string, command: GameCommandInput): Promise<SendOutcome | null> => {
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    try {
      return await session.send(command);
    } finally {
      inFlight.delete(key);
    }
  };

  // Entering the stage starts its clock, once (the server refuses a second start anyway).
  let cancelRetry: () => void = () => undefined;
  const startIfNeeded = (): void => {
    const current = game.value;
    if (current?.game.stage !== "s2" || current.s2 !== null || cleared.value) return;
    void send("start", { type: "s2.start" }).then((outcome) => {
      if (outcome !== null && needsStart(outcome)) {
        cancelRetry = scheduler.schedule(startIfNeeded, STAGE2_START_RETRY_MS);
      }
    });
  };
  watch(game, startIfNeeded, { immediate: true });
  const passShowing = shallowRef(false);
  let cancelPassHold: () => void = () => undefined;
  let cancelTicks: (() => void)[] = [];
  const stopTicks = (): void => {
    for (const cancel of cancelTicks) cancel();
    cancelTicks = [];
  };
  onScopeDispose(() => {
    cancelRetry();
    cancelPassHold();
    stopTicks();
  });
  /** Holds the clear effect back and beeps once as each row of the pass starts to show. */
  const holdForPass = (pass: Extract<Verdict, { kind: "cleared" }>): void => {
    cancelPassHold();
    stopTicks();
    passShowing.value = true;
    cancelPassHold = scheduler.schedule(() => {
      passShowing.value = false;
    }, STAGE2_PASS_HOLD_MS);
    cancelTicks = verdictTicks(pass.checks?.length ?? 0).map(({ atMs, tone }) =>
      scheduler.schedule(() => {
        context.sfx.tone(tone);
      }, atMs),
    );
  };

  // The grid of this start of the stage: the one kept for a reload, or the sheet as delivered.
  watch(
    () => state.value?.startedAt ?? null,
    (at) => {
      startedAt = at;
      hot.value = NO_CELLS;
      const current = state.value;
      if (at === null || current === null) {
        grid.value = [];
        return;
      }
      const kept = record()?.read() ?? null;
      if (kept?.startedAt === at) {
        addendumIn = kept.addendumIn;
        grid.value = kept.grid;
        return;
      }
      addendumIn = isStage2AddendumTaken(current);
      setGrid(stage2FreshGrid(current));
    },
    { immediate: true },
  );

  // The addendum taken (from this screen, or another tab): its rows go into the grid once.
  watch(
    () => state.value?.addendumTakenAt ?? null,
    (takenAt) => {
      if (takenAt === null || addendumIn) return;
      addendumIn = true;
      setGrid([...grid.value, ...stage2AddendumGridRows()]);
    },
    { immediate: true },
  );

  // The addendum lands at the deadline: a mail and its sound, no alarm (it is not a trap).
  useAtServerTime(
    serverNow,
    () => {
      const current = state.value;
      if (current === null || cleared.value) return null;
      return { key: `addendum:${String(current.startedAt)}`, at: stage2DeadlineAt(current) };
    },
    () => {
      const current = state.value;
      if (current === null) return;
      if (serverNow.value - stage2DeadlineAt(current) < STAGE2_LANDING_SOUND_MS) {
        context.sfx.play("decision1");
      }
    },
  );

  return {
    state,
    cleared,
    grid,
    hot,
    verdict,
    inboxRows: computed(() => stage2InboxRows(state.value, serverNow.value)),
    canTake: computed(() => !cleared.value && stage2CanTake(state.value, serverNow.value)),
    edit(row, column, value) {
      setGrid(withCell(grid.value, row, column, value));
      hot.value = withoutCell(hot.value, row, column);
    },
    addRow() {
      setGrid(withEmptyRow(grid.value));
    },
    deleteRow(row) {
      const next = withoutRow(grid.value, hot.value, row);
      setGrid(next.grid);
      hot.value = next.hot;
    },
    reset() {
      if (state.value === null) return;
      setGrid(stage2FreshGrid(state.value));
      hot.value = NO_CELLS;
    },
    async submit() {
      if (state.value === null || cleared.value || verdict.value?.kind === "checking") return;
      const submitted = state.value;
      verdict.value = CHECKING;
      const outcome = await session.send({ type: "s2.submit", grid: grid.value });
      const result = stage2SubmitResult(
        outcome,
        stage2ExpectedRowCount(submitted, serverNow.value),
      );
      verdict.value = result.verdict;
      if (result.verdict.kind === "cleared") holdForPass(result.verdict);
      if (result.rejected) {
        hot.value = result.hot;
        context.sfx.play("cancel");
      }
    },
    async take() {
      if (!stage2CanTake(state.value, serverNow.value) || cleared.value) return;
      await send("take", { type: "s2.take-addendum" });
    },
    reopen() {
      if (verdict.value?.kind === "rejected") verdict.value = null;
    },
    pasteError,
    landed,
    sendTable(text) {
      if (state.value === null || cleared.value || verdict.value?.kind === "checking") return;
      const read = readStage2TableForGrid(text);
      if (read.kind === "error") {
        pasteError.value = stage2PasteErrorText(read);
        return;
      }
      pasteError.value = null;
      // A table sent while the verdict is up opens the grid again, so the team sees it land.
      verdict.value = null;
      setGrid(read.rows);
      hot.value = NO_CELLS;
      landed.value += 1;
    },
    pauseClear: computed(() => verdict.value?.kind === "checking" || passShowing.value),
  };
};
