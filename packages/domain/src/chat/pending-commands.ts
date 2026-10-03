import { z } from "zod";

import { detectPii } from "../pii.js";
import type { CommandStatus } from "../schemas/chat.js";
import { commandIdSchema } from "../schemas/team-state.js";

/**
 * The chat messages this tab sent but has not seen settled: which commandId each one went out
 * with. Resending the same text to the same thread must reuse that id — the server applies a
 * commandId once, so a fresh id would store the message twice and call the AI twice.
 *
 * The key is the thread and the text: the same text to another stage's thread is another
 * message. The server picks the prompt from the thread's stage, so the key needs nothing else.
 *
 * Kept in insertion order (the first entry is the oldest), at most PENDING_COMMAND_LIMIT: enough
 * for one stage of trial and error; the oldest go first. The mock's makePendingCommand and
 * reconcilePendingCommands, as pure functions.
 */
export type PendingCommands = ReadonlyMap<string, string>;

export const PENDING_COMMAND_LIMIT = 20;

/**
 * How many ids one `GET /chat?commandIds=` may ask about (the Worker's CHAT_COMMAND_IDS_MAX).
 * Those left out are only kept, never dropped, so leaving some out cannot cause a double send.
 */
export const PENDING_QUERY_LIMIT = 20;

/** Thread ids are uuids and hold no space, so the first space ends the thread id. */
export const pendingKey = (threadId: string, text: string): string => `${threadId} ${text}`;

const pendingKeySchema = z.string().refine((key) => {
  const space = key.indexOf(" ");
  return space > 0 && space < key.length - 1 && z.uuid().safeParse(key.slice(0, space)).success;
});

/** What sessionStorage holds: `[key, commandId]` pairs, oldest first. */
const storedPendingSchema = z.array(z.tuple([pendingKeySchema, commandIdSchema]));

const keepNewest = (entries: readonly (readonly [string, string])[]): PendingCommands =>
  new Map(entries.slice(-PENDING_COMMAND_LIMIT));

/**
 * The id to send `key` with: the one already given to it, or `newId()` added as the newest
 * (dropping the oldest beyond the limit).
 */
export const pendingIdFor = (
  pending: PendingCommands,
  key: string,
  newId: () => string,
): { readonly pending: PendingCommands; readonly commandId: string } => {
  const known = pending.get(key);
  if (known !== undefined) return { pending, commandId: known };
  const commandId = newId();
  return { pending: keepNewest([...pending, [key, commandId]]), commandId };
};

/**
 * Joins what sessionStorage held (`stored`) with the ids this tab kept in memory (`kept`), for
 * a join of the same team: sessionStorage may have refused every write, and an id only in
 * memory must not be lost (a fresh id for the same text would store it twice). `kept` is the
 * newer: for a key in both, its id wins and its order counts. At most PENDING_COMMAND_LIMIT
 * are kept, the oldest go first.
 */
export const mergePending = (stored: PendingCommands, kept: PendingCommands): PendingCommands =>
  keepNewest([...[...stored].filter(([key]) => !kept.has(key)), ...kept]);

/** Drops `key` once its send has settled (answered, or refused with nothing saved). */
export const forgetPending = (pending: PendingCommands, key: string): PendingCommands => {
  if (!pending.has(key)) return pending;
  const next = new Map(pending);
  next.delete(key);
  return next;
};

/**
 * Drops every entry whose text holds personal information (`detectPii`): a key holds the text,
 * so such an entry must be neither kept nor written (user decision 1 of 2026-09-27). An earlier
 * screen kept them; they go on the next read. Returns `pending` itself when nothing goes.
 */
export const forgetPiiPending = (pending: PendingCommands): PendingCommands => {
  const kept = [...pending].filter(([key]) => detectPii(key.slice(key.indexOf(" ") + 1)) === null);
  return kept.length === pending.size ? pending : new Map(kept);
};

/** The text to keep in sessionStorage. */
export const storedPendingText = (pending: PendingCommands): string => JSON.stringify([...pending]);

/**
 * Reads what sessionStorage held. Anything broken is dropped whole: a fresh id on the next send
 * does less harm than half of a broken record.
 */
export const parseStoredPending = (raw: string | null): PendingCommands => {
  if (raw === null) return new Map();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const parsed = storedPendingSchema.safeParse(json);
  return parsed.success ? keepNewest(parsed.data) : new Map();
};

/**
 * After a reload: drops the ids the server says it has processed. `pending` (still running) and
 * `unknown` (never arrived, or long cleaned up) stay: a resend with the same id is then settled
 * by the server either way. An answer that did not ask (`commands` absent) drops nothing.
 */
export const reconcilePending = (
  pending: PendingCommands,
  commands: Readonly<Record<string, CommandStatus>> | undefined,
): PendingCommands => {
  if (commands === undefined) return pending;
  const kept = [...pending].filter(([, commandId]) => commands[commandId] !== "processed");
  return kept.length === pending.size ? pending : new Map(kept);
};

/** The ids to ask the server about after a reload: the newest ones, each once. */
export const pendingQueryIds = (pending: PendingCommands): readonly string[] =>
  [...new Set(pending.values())].slice(-PENDING_QUERY_LIMIT);
