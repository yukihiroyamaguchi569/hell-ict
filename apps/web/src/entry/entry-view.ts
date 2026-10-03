import { teamCodeSchema } from "@hell-ict/domain";
import type { TeamCode } from "@hell-ict/domain";
import { z } from "zod";

import type { GameSessionStatus, JoinOutcome } from "../composables/use-game-session.js";

/*
 * What the entry screen says and allows (mock #ov-entry, attemptEnter, updateEntryProbeUi).
 * Pure: the screen draws what these return.
 */

/** Fits the header chip and the certificate's addressee (mock TEAM_NAME_MAX). */
export const TEAM_NAME_MAX = 12;

/** The digits of the team code: one box each, typed while the facilitator reads it out. */
export const TEAM_CODE_LENGTH = 6;

export type EntryCheck =
  | { readonly ok: true; readonly teamCode: TeamCode; readonly teamName: string }
  | { readonly ok: false; readonly message: string };

/** The name as it is kept: trimmed and cut to the chip's length. */
export const normalizeTeamName = (name: string): string => name.trim().slice(0, TEAM_NAME_MAX);

/** The form before anything is sent. The name first, as in the mock. */
export const checkEntry = (code: string, name: string): EntryCheck => {
  const teamName = normalizeTeamName(name);
  if (teamName === "") {
    return {
      ok: false,
      message: "チーム名を入力してください。チームで相談して決めてください。",
    };
  }
  const parsed = teamCodeSchema.safeParse(code);
  if (!parsed.success) {
    return { ok: false, message: "チームコードはASCII数字6桁で入力してください。" };
  }
  return { ok: true, teamCode: parsed.data, teamName };
};

/**
 * `GET /api/health` as the Worker answers it. A 200 alone is not enough: static hosting answers
 * any path with index.html, and the screen would then take HTML for the API.
 */
const healthSchema = z.object({
  status: z.literal("ok"),
  guards: z.record(z.string(), z.unknown()),
});

export const isHealthy = (body: unknown): boolean => healthSchema.safeParse(body).success;

/** The start-up check that the API answers (mock `probeLive`). */
export type ProbeState = "pending" | "ok" | "failed";

export interface EntryFacts {
  readonly probe: ProbeState;
  readonly status: GameSessionStatus;
  /** A join from this form is under way. */
  readonly entering: boolean;
}

/** What [再試行] does: check the API again, or restore the saved team again. */
export type EntryRetry = "probe" | "restore";

export interface EntryNotice {
  /** The line under the form ("" for none). */
  readonly text: string;
  /** A failure: drawn in red. */
  readonly bad: boolean;
  readonly retry: EntryRetry | null;
  readonly canEnter: boolean;
}

const QUIET: EntryNotice = { text: "", bad: false, retry: null, canEnter: true };

/**
 * No entering until the API is known to answer, and no silent fallback when it does not
 * (decision E of #238: an error and [再試行], nothing else). A restore that failed also blocks
 * the form: the saved team is still this PC's team. A restore under way does not: a team may
 * type another code meanwhile, and the join started last wins.
 */
export const entryNotice = (facts: EntryFacts): EntryNotice => {
  if (facts.probe === "pending") {
    return { text: "接続を確認しています…", bad: false, retry: null, canEnter: false };
  }
  if (facts.probe === "failed") {
    return {
      text: "サーバに接続できません。ネットワークを確認して再試行してください。",
      bad: true,
      retry: "probe",
      canEnter: false,
    };
  }
  if (facts.entering) return { text: "入室しています…", bad: false, retry: null, canEnter: false };
  if (facts.status === "restore-failed") {
    return {
      text: "復元に失敗しました。ネットワークを確認して再試行してください。",
      bad: true,
      retry: "restore",
      canEnter: false,
    };
  }
  if (facts.status === "joining") return { ...QUIET, text: "前回のチームへ戻っています…" };
  return QUIET;
};

/** The error under the form after a join from it did not go through ("" for none). */
export const joinErrorMessage = (outcome: JoinOutcome): string => {
  switch (outcome) {
    case "not-found":
      return "このチームコードでは入室できません。コードを確かめてください。";
    case "failed":
      return "入室に失敗しました。時間を置いて再試行してください。";
    default:
      // ok, or superseded by a later join: that one reports for itself.
      return "";
  }
};

/**
 * The name field after the team code was changed. A name the team typed stays. Otherwise the
 * field follows the code: the name this PC kept for it, or empty — the name filled in for
 * another code must not be carried over, saved and reported under this one.
 */
export const nameAfterCodeChange = (field: {
  readonly current: string;
  readonly stored: string;
  readonly typed: boolean;
}): string => (field.typed ? field.current : field.stored);

/** The header chip: the team's name, or its code when this PC does not know the name. */
export const teamChipText = (teamName: string, teamCode: string | null): string =>
  teamName !== "" ? teamName : (teamCode ?? "");
