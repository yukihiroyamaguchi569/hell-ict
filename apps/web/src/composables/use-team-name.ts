import { readonly, ref, watch } from "vue";
import type { Ref } from "vue";

import { normalizeTeamName } from "../entry/entry-view.js";
import type { KeyValueStorage } from "../ports.js";

/** Same key as the mock, so a PC that ran the mock keeps the name (mock `teamNameKey`). */
export const teamNameKey = (teamCode: string): string => `hellTeamName:${teamCode}`;

/**
 * The team's name, kept on this PC per team code: a reload or a re-entry on the same PC gets it
 * back, a team that moves to a spare PC types it again. The storage may throw (blocked site
 * data): the name is then only lost, the game goes on.
 */
export interface TeamNameStore {
  read(teamCode: string): string;
  write(teamCode: string, name: string): void;
}

export const createTeamNameStore = (storage: KeyValueStorage): TeamNameStore => ({
  read(teamCode) {
    try {
      return normalizeTeamName(storage.getItem(teamNameKey(teamCode)) ?? "");
    } catch {
      return "";
    }
  },
  write(teamCode, name) {
    try {
      storage.setItem(teamNameKey(teamCode), name);
    } catch {
      // Not saved: a reload shows the team code in the chip instead.
    }
  },
});

export interface TeamName {
  /** The name of the team on screen ("" while unknown). */
  readonly name: Readonly<Ref<string>>;
  /** The form joins with this name: keep it, and show it if the team is already on screen. */
  remember(teamCode: string, name: string): void;
}

/** Follows the team on screen: a restored team gets back the name this PC kept for it. */
export const useTeamName = (
  teamCode: Readonly<Ref<string | null>>,
  store: TeamNameStore,
): TeamName => {
  const name = ref("");
  // What this page was told, for when the storage could not keep it.
  const told = new Map<string, string>();
  const lookUp = (code: string): string => told.get(code) ?? store.read(code);
  watch(
    teamCode,
    (code) => {
      name.value = code === null ? "" : lookUp(code);
    },
    { immediate: true },
  );
  return {
    name: readonly(name),
    remember(code, next) {
      told.set(code, next);
      store.write(code, next);
      if (code === teamCode.value) name.value = next;
    },
  };
};
