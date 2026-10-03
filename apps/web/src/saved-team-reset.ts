import { TEAM_CODE_STORAGE_KEY } from "./composables/use-game-session.js";
import type { AddressBar, KeyValueStorage } from "./ports.js";

/** `/?reset` (any value): forget the saved team, so a shared PC shows the entry form again. */
export const RESET_QUERY_KEY = "reset";

/** Only to parse a path; never shown or requested. */
const PARSE_BASE = "http://localhost";

/**
 * The URL to put back once the saved team is forgotten: the same path, query (minus `reset`)
 * and hash. `null` when the URL does not ask for a reset.
 */
export const urlWithoutReset = (current: string): string | null => {
  const url = new URL(current, PARSE_BASE);
  if (!url.searchParams.has(RESET_QUERY_KEY)) return null;
  url.searchParams.delete(RESET_QUERY_KEY);
  return `${url.pathname}${url.search}${url.hash}`;
};

export interface SavedTeamResetDeps {
  readonly address: AddressBar;
  readonly storage: KeyValueStorage;
}

/**
 * Run before the session restores the saved team. The team names (`hellTeamName:<code>`) and
 * the preferences stay. `reset` leaves the URL so that a reload does not forget again.
 */
export const forgetSavedTeamIfAsked = ({ address, storage }: SavedTeamResetDeps): boolean => {
  const next = urlWithoutReset(address.current());
  if (next === null) return false;
  try {
    storage.removeItem(TEAM_CODE_STORAGE_KEY);
  } catch {
    // Blocked site data: the restore cannot read a saved team either. The page still starts.
  }
  address.replace(next);
  return true;
};
