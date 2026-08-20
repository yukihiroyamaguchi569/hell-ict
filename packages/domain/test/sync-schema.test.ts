import { describe, expect, it } from "vitest";

import { teamSyncMessageSchema } from "../src/schemas/sync.js";

const teamSnapshot = {
  teamCode: "000000",
  revision: 0,
  state: {
    mode: "peace",
    stage: "prologue",
    metrics: { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 },
  },
};

const chatSnapshot = {
  teamCode: "000000",
  revision: 0,
  threads: [
    {
      threadId: "00000000-0000-4000-8000-000000000001",
      title: "メイン",
      messages: [],
    },
  ],
};

describe("WebSocket配信envelopeのschema", () => {
  it("kindごとに対応するsnapshotを受理する", () => {
    expect(teamSyncMessageSchema.parse({ kind: "team", snapshot: teamSnapshot })).toEqual({
      kind: "team",
      snapshot: teamSnapshot,
    });
    expect(teamSyncMessageSchema.parse({ kind: "chat", snapshot: chatSnapshot })).toEqual({
      kind: "chat",
      snapshot: chatSnapshot,
    });
  });

  it("kindとsnapshotの取り違え、未知kindを拒否する", () => {
    for (const input of [
      { kind: "team", snapshot: chatSnapshot },
      { kind: "chat", snapshot: teamSnapshot },
      { kind: "other", snapshot: teamSnapshot },
      { kind: "team", snapshot: teamSnapshot, extra: true },
    ]) {
      expect(teamSyncMessageSchema.safeParse(input).success).toBe(false);
    }
  });
});
