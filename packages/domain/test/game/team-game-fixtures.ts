import {
  stage1Answers,
  stage3Answers,
  stage4Answers,
  stage5Answers,
  stage6Answers,
} from "@hell-ict/content/answers";

import { gameInstantSchema } from "../../src/schemas/game.js";
import { teamGameCommandSchema } from "../../src/schemas/team-game.js";
import type { TeamGameCommand } from "../../src/schemas/team-game.js";
import type { TeamGameNow } from "../../src/game/team-game.js";
import { STAGE1_SCHEDULES } from "../../src/stages/s1.js";
import type { Stage2Row } from "../../src/stages/s2-table.js";
import { nextId } from "./helpers.js";

/** The server's clock at `ms` after the start of the test game. */
export const START_MS = Date.parse("2026-10-31T01:00:00.000Z");

export const at = (offsetMs: number): TeamGameNow => ({
  ms: START_MS + offsetMs,
  at: gameInstantSchema.parse(new Date(START_MS + offsetMs).toISOString()),
});

/**
 * A screen command with a fresh id (generation 0, as a team that was never reset). It goes
 * through the wire schema, as the server's does, so a fixture cannot drift from it.
 */
export const command = (
  type: TeamGameCommand["type"],
  payload: Record<string, unknown> = {},
): TeamGameCommand =>
  teamGameCommandSchema.parse({ type, commandId: nextId(), generation: 0, ...payload });

/** Long and polite: never curt (70 characters or more and a polite phrase). */
export const POLITE_REPLY = stage1Answers.politeReply;

/** The Stage 1 mails of round 1, in landing order. */
export const ROUND1 = STAGE1_SCHEDULES[1];

/** Twenty rows that pass every check of the Stage 2 grid (content is not compared). */
export const GOOD_GRID: Stage2Row[] = Array.from({ length: 20 }, (_, i) => [
  String(i + 1),
  "5A",
  "2026-08-01",
  i % 2 === 0 ? "陽性" : "陰性",
  "なし",
  "",
]);

export const STAGE3_OK = stage3Answers.ok;

export const STAGE3_TRAP = { ...STAGE3_OK, ppe: stage3Answers.trap.ppe };

export const STAGE4_SUMMARY_OK = stage4Answers.summaryOk;
export const STAGE4_ACTION_OK = stage4Answers.actionOk;

/** The fever list, cleaned: every ID, one date style, every temperature with its unit. */
export const STAGE5_LIST_OK = stage5Answers.cleanList;

export const STAGE6_PROMPT_OK = stage6Answers.promptOk;
