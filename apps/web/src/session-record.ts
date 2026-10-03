import type { z } from "zod";

import type { KeyValueStorage } from "./ports.js";

/**
 * One value a stage keeps in sessionStorage for the team (a draft, what has been read), so a
 * reload puts it back. The key is `hellVue<name>:<teamCode>`: the prefix kept it apart from the
 * `hellInbox:*` and `hellPending:*` keys of the mock that was served on the same origin.
 *
 * What comes back is checked against the schema: a value that is not JSON or not of the shape
 * (an older build, a hand edit) is removed and read as nothing. The storage may throw (blocked
 * site data): reads then give nothing and writes are dropped, and the stage goes on in memory.
 */
export interface SessionRecord<T> {
  read(): T | null;
  write(value: T): void;
  clear(): void;
}

export const sessionRecordKey = (name: string, teamCode: string): string =>
  `hellVue${name}:${teamCode}`;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const sessionRecord = <T>(
  storage: KeyValueStorage,
  key: string,
  schema: z.ZodType<T>,
): SessionRecord<T> => {
  const clear = (): void => {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing to do: the storage is blocked, so nothing was kept either.
    }
  };
  return {
    read() {
      let text: string | null;
      try {
        text = storage.getItem(key);
      } catch {
        return null;
      }
      if (text === null) return null;
      const parsed = schema.safeParse(parseJson(text));
      if (parsed.success) return parsed.data;
      clear();
      return null;
    },
    write(value) {
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch {
        // Kept in memory only: a reload starts this value over.
      }
    },
    clear,
  };
};
