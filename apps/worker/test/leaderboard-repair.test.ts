import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { commandResultSchema, teamSyncMessageSchema } from "@hell-ict/domain";
import { describe, expect, it, vi } from "vitest";

import type { TeamRoom } from "../src/team-room.js";

/**
 * Characterization tests for the leaderboard repair after a team command (team-room split
 * 11). Written against TeamRoom before repairLeaderboard moved to leaderboard-repair.ts,
 * and kept unchanged after. They pin what happens around the only await in the repair:
 * the processed row is rewritten and the snapshot broadcast only after the upsert
 * succeeds, in that order, and nothing is written when it throws.
 */

type LeaderboardMode = "healthy" | "down";

type Trace = {
  /** SQL statements, upserts and broadcasts, in the order they happened. */
  readonly events: string[];
  /** Arguments each upsert received. */
  readonly upserts: unknown[][];
};

const GENERATION = "SELECT value FROM reset_generation WHERE id = 1";
const UPDATE_PROCESSED = "UPDATE processed_commands SET result = ? WHERE command_id = ?";
const INSERT_PROCESSED = "INSERT INTO processed_commands (command_id, result) VALUES (?, ?)";
const READ_PROCESSED = "SELECT result FROM processed_commands WHERE command_id = ?";

const enterStage1 = (commandId: string, generation: number) => ({
  type: "enter-stage1",
  commandId,
  expectedRevision: 0,
  generation,
});

/**
 * Runs `body` inside the team's DO with the global leaderboard either healthy (the real
 * upsert runs) or down (every upsert rejects over RPC), and records what the DO did meanwhile.
 * Broadcasts are captured from a socket handed to the DO through getWebSockets.
 */
const traceRepair = <T>(
  teamCode: string,
  mode: LeaderboardMode,
  body: (instance: TeamRoom) => Promise<T>,
): Promise<{ result: T; trace: Trace }> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance, state) => {
    const trace: Trace = { events: [], upserts: [] };
    const namespace = env.RACE_LEADERBOARD;
    const getByName = namespace.getByName.bind(namespace);
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const socket = new WebSocketPair()[1];
    vi.spyOn(state.storage.sql, "exec").mockImplementation((query, ...bindings) => {
      trace.events.push(query);
      return exec(query, ...bindings);
    });
    vi.spyOn(namespace, "getByName").mockImplementation((name, options) => {
      const stub = getByName(name, options);
      // RPC stubs cannot be bound, so the real call goes through a second, unspied stub.
      const real = getByName(name, options);
      vi.spyOn(stub, "upsert").mockImplementation((...args) => {
        trace.events.push("upsert");
        trace.upserts.push(args);
        if (mode === "healthy") return real.upsert(...args);
        // A real RPC rejection: the leaderboard refuses a team code that fails its schema.
        return real.upsert("down", args[1], args[2]);
      });
      return stub;
    });
    vi.spyOn(state, "getWebSockets").mockReturnValue([socket]);
    vi.spyOn(socket, "send").mockImplementation((data) => {
      const message = teamSyncMessageSchema.parse(JSON.parse(String(data)) as unknown);
      trace.events.push(`broadcast:${message.kind}:${message.snapshot.revision}`);
    });
    try {
      return { result: await body(instance), trace };
    } finally {
      vi.restoreAllMocks();
    }
  });

/** The stored result of a processed team command, read straight from the DO's table. */
const processedResult = (teamCode: string, commandId: string): Promise<unknown> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
    const row = state.storage.sql.exec<{ result: string }>(READ_PROCESSED, commandId).toArray()[0];
    return row === undefined ? null : commandResultSchema.parse(JSON.parse(row.result) as unknown);
  });

describe("リーダーボードの修復", () => {
  it("upsertが通ると、処理済みの行を書き換えてから1回だけ配信する", async () => {
    const teamCode = "730001";
    const commandId = "00000000-0000-4000-8000-000000073001";
    // Advance the reset generation so the upsert's third argument is not the default 0.
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance) => {
      await instance.join(teamCode);
      await instance.resetTeam(teamCode);
      await instance.join(teamCode);
    });

    const { result, trace } = await traceRepair(teamCode, "healthy", (instance) =>
      instance.command(teamCode, enterStage1(commandId, 1)),
    );

    expect(result).toMatchObject({ applied: true, leaderboardPending: false });
    expect(trace.upserts).toHaveLength(1);
    expect(trace.upserts[0]).toEqual([
      teamCode,
      expect.objectContaining({ teamCode, revision: 1 }),
      1,
    ]);
    const tail = trace.events.slice(trace.events.indexOf(INSERT_PROCESSED));
    // The generation is read while the upsert's arguments are evaluated, before the await.
    expect(tail).toEqual([
      INSERT_PROCESSED,
      GENERATION,
      "upsert",
      UPDATE_PROCESSED,
      "broadcast:team:1",
    ]);
    await expect(processedResult(teamCode, commandId)).resolves.toMatchObject({
      leaderboardPending: false,
    });
  });

  it("upsertが例外なら、行も配信も変えずにleaderboardPending: trueのまま返し、再送で直る", async () => {
    const teamCode = "730002";
    const commandId = "00000000-0000-4000-8000-000000073002";
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (instance) =>
      instance.join(teamCode),
    );

    const failed = await traceRepair(teamCode, "down", (instance) =>
      instance.command(teamCode, enterStage1(commandId, 0)),
    );

    expect(failed.result).toMatchObject({ applied: true, leaderboardPending: true });
    expect(failed.trace.upserts).toHaveLength(1);
    expect(failed.trace.events).not.toContain(UPDATE_PROCESSED);
    expect(failed.trace.events.filter((event) => event.startsWith("broadcast:"))).toEqual([]);
    expect(failed.trace.events.at(-1)).toBe("upsert");
    await expect(processedResult(teamCode, commandId)).resolves.toMatchObject({
      leaderboardPending: true,
      snapshot: { revision: 1 },
    });

    // The same commandId replays the stored pending result and repairs it.
    const repaired = await traceRepair(teamCode, "healthy", (instance) =>
      instance.command(teamCode, enterStage1(commandId, 0)),
    );

    expect(repaired.result).toMatchObject({ applied: true, leaderboardPending: false });
    expect(repaired.trace.events).toEqual([
      GENERATION,
      READ_PROCESSED,
      GENERATION,
      "upsert",
      UPDATE_PROCESSED,
      "broadcast:team:1",
    ]);
    await expect(processedResult(teamCode, commandId)).resolves.toMatchObject({
      leaderboardPending: false,
    });
  });

  it("leaderboardPending: falseの結果を再送しても、upsertも書き込みも配信もしない", async () => {
    const teamCode = "730003";
    const commandId = "00000000-0000-4000-8000-000000073003";
    const first = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (instance) => {
      await instance.join(teamCode);
      return instance.command(teamCode, enterStage1(commandId, 0));
    });
    expect(first).toMatchObject({ leaderboardPending: false });

    const replayed = await traceRepair(teamCode, "healthy", (instance) =>
      instance.command(teamCode, enterStage1(commandId, 0)),
    );

    expect(replayed.result).toEqual(first);
    expect(replayed.trace.upserts).toEqual([]);
    expect(replayed.trace.events).toEqual([GENERATION, READ_PROCESSED]);
  });
});
