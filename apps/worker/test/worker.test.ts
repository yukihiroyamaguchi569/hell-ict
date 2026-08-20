import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const session = async (teamCode: string): Promise<Response> =>
  exports.default.fetch(
    new Request("https://example.test/api/session", {
      method: "POST",
      body: JSON.stringify({ teamCode }),
    }),
  );

describe("P1B Worker", () => {
  it("6桁コードで初期状態を作成し、同じコードでは復元する", async () => {
    const first = await session("000000");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      teamCode: "000000",
      revision: 0,
      state: {
        stage: "prologue",
        mode: "peace",
        metrics: { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 },
      },
    });
    const again = await session("000000");
    await expect(again.json()).resolves.toMatchObject({
      teamCode: "000000",
      revision: 0,
      state: { stage: "prologue" },
    });
  });

  it("重複commandIdを一度だけ適用する", async () => {
    await session("000001");
    const command = {
      type: "enter-stage1",
      commandId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
    };
    const endpoint = "https://example.test/api/teams/000001/commands";
    const first = await exports.default.fetch(
      new Request(endpoint, { method: "POST", body: JSON.stringify(command) }),
    );
    const repeated = await exports.default.fetch(
      new Request(endpoint, { method: "POST", body: JSON.stringify(command) }),
    );
    await expect(first.json()).resolves.toMatchObject({
      applied: true,
      leaderboardPending: false,
      snapshot: { revision: 1, state: { stage: "stage1" } },
    });
    await expect(repeated.json()).resolves.toMatchObject({
      applied: true,
      leaderboardPending: false,
      snapshot: { revision: 1, state: { stage: "stage1" } },
    });
  });

  it("不正な入力と競合は状態を変えずに拒否する", async () => {
    expect((await session("１２３４５６")).status).toBe(400);
    await session("000002");
    const endpoint = "https://example.test/api/teams/000002/commands";
    const invalid = await exports.default.fetch(
      new Request(endpoint, {
        method: "POST",
        body: JSON.stringify({
          type: "enter-stage1",
          commandId: "00000000-0000-4000-8000-000000000002",
          expectedRevision: 0.5,
        }),
      }),
    );
    const stale = await exports.default.fetch(
      new Request(endpoint, {
        method: "POST",
        body: JSON.stringify({
          type: "enter-stage1",
          commandId: "00000000-0000-4000-8000-000000000003",
          expectedRevision: 1,
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(stale.status).toBe(409);
    await expect((await session("000002")).json()).resolves.toMatchObject({
      revision: 0,
      state: { stage: "prologue" },
    });
  });
});
