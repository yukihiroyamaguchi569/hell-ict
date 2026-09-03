import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  checkpointStateSchema,
  httpErrorSchema,
  saveCheckpointResultSchema,
} from "@hell-ict/domain";
import type { CheckpointBody, CheckpointState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { handleCheckpointState, handleSaveCheckpoint } from "../src/index.js";
import { postJson } from "./support.js";

const now = "2026-09-03T10:00:00.000Z";
const later = "2026-09-03T10:05:00.000Z";

const body = (overrides: Partial<CheckpointBody> = {}): CheckpointBody => ({
  view: "stage3-manual",
  pos: 2,
  elapsedMs: 60_000,
  trap: { s3Used: false, s4Used: false },
  data: { answer: "A" },
  ...overrides,
});

const saveRequest = (teamCode: string, command: unknown): Request =>
  new Request(`https://example.test/api/teams/${teamCode}/checkpoint`, {
    method: "POST",
    body: JSON.stringify(command),
  });

const save = (
  teamCode: string,
  command: {
    commandId: string;
    expectedRevision: number;
    body?: Partial<CheckpointBody>;
    rawBody?: unknown;
  },
  nowIso: string = now,
): Promise<Response> =>
  handleSaveCheckpoint(
    saveRequest(teamCode, {
      type: "save-checkpoint",
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      body: command.rawBody ?? body(command.body),
    }),
    env,
    teamCode,
    nowIso,
  );

const load = async (teamCode: string, nowIso: string = now): Promise<CheckpointState> => {
  const response = await handleCheckpointState(env, teamCode, nowIso);
  expect(response.status).toBe(200);
  return checkpointStateSchema.parse(await response.json());
};

const id = (suffix: string): string => `00000000-0000-4000-8000-000000000${suffix}`;

describe("チェックポイントAPI", () => {
  it("未保存のチームにはnullとserverNowを返す", async () => {
    const state = await load("500000");
    expect(state.checkpoint).toBeNull();
    expect(state.serverNow).toBe(now);
  });

  it("serverNowはISO 8601で返る（時刻を注入しない既定経路）", async () => {
    const response = await exports.default.fetch(
      new Request("https://example.test/api/teams/500001/checkpoint"),
    );
    expect(response.status).toBe(200);
    const state = checkpointStateSchema.parse(await response.json());
    expect(state.checkpoint).toBeNull();
    expect(Number.isNaN(Date.parse(state.serverNow))).toBe(false);
  });

  it("初回保存はexpectedRevision 0を受け付け、revision 1のsnapshotを返す", async () => {
    const response = await save("500002", { commandId: id("101"), expectedRevision: 0 });

    expect(response.status).toBe(200);
    const { snapshot } = saveCheckpointResultSchema.parse(await response.json());
    expect(snapshot).toEqual({ teamCode: "500002", revision: 1, savedAt: now, body: body() });
    await expect(load("500002")).resolves.toMatchObject({ checkpoint: snapshot });
  });

  it("POSTルートが配線されている", async () => {
    const response = await postJson("/api/teams/500003/checkpoint", {
      type: "save-checkpoint",
      commandId: id("102"),
      expectedRevision: 0,
      body: body(),
    });

    expect(response.status).toBe(200);
    const { snapshot } = saveCheckpointResultSchema.parse(await response.json());
    expect(snapshot.revision).toBe(1);
  });

  it("同じcommandIdの再送は状態を進めず同じsnapshotを返す", async () => {
    const first = await save("500004", { commandId: id("103"), expectedRevision: 0 });
    const firstResult = saveCheckpointResultSchema.parse(await first.json());

    // 再送は本文が変わっていても保存済み結果を返す（冪等）。
    const again = await save(
      "500004",
      { commandId: id("103"), expectedRevision: 0, body: { pos: 7 } },
      later,
    );

    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual(firstResult);
    const state = await load("500004");
    expect(state.checkpoint?.revision).toBe(1);
    expect(state.checkpoint?.body.pos).toBe(2);
  });

  it("上書き済みのcommandIdの再送は409で拒否し、古いbodyを復活させない", async () => {
    await save("500023", { commandId: id("127"), expectedRevision: 0, body: { pos: 1 } });
    await save("500023", { commandId: id("128"), expectedRevision: 1, body: { pos: 5 } }, later);

    const stale = await save("500023", {
      commandId: id("127"),
      expectedRevision: 0,
      body: { pos: 1 },
    });

    expect(stale.status).toBe(409);
    expect(httpErrorSchema.parse(await stale.json()).code).toBe("conflict");
    await expect(load("500023")).resolves.toMatchObject({
      checkpoint: { revision: 2, body: { pos: 5 } },
    });
  });

  it("revisionが一致しない保存は409で拒否し、状態を変えない", async () => {
    await save("500005", { commandId: id("104"), expectedRevision: 0 });

    const conflict = await save("500005", {
      commandId: id("105"),
      expectedRevision: 0,
      body: { pos: 5 },
    });

    expect(conflict.status).toBe(409);
    expect(httpErrorSchema.parse(await conflict.json()).code).toBe("conflict");
    const state = await load("500005");
    expect(state.checkpoint?.revision).toBe(1);
    expect(state.checkpoint?.body.pos).toBe(2);
  });

  it("conflictで拒否されたcommandIdは台帳に残らず、正しいrevisionで再送すれば成功する", async () => {
    await save("500015", { commandId: id("115"), expectedRevision: 0 });
    const retried = id("116");
    const conflict = await save("500015", {
      commandId: retried,
      expectedRevision: 0,
      body: { pos: 5 },
    });
    expect(conflict.status).toBe(409);

    // 台帳へ書かれていれば、この再送は保存済み結果（conflict時のsnapshot）を
    // 返すか失敗する。状態更新と台帳が同じトランザクションで巻き戻る保証を固定する。
    const accepted = await save(
      "500015",
      { commandId: retried, expectedRevision: 1, body: { pos: 5 } },
      later,
    );

    expect(accepted.status).toBe(200);
    await expect(load("500015")).resolves.toMatchObject({
      checkpoint: { revision: 2, savedAt: later, body: { pos: 5 } },
    });
  });

  it("発動済みの罠をfalseへ戻す保存は409で拒否し、保存されない", async () => {
    await save("500006", {
      commandId: id("106"),
      expectedRevision: 0,
      body: { trap: { s3Used: true, s4Used: false } },
    });

    const regression = await save("500006", {
      commandId: id("107"),
      expectedRevision: 1,
      body: { pos: 6, trap: { s3Used: false, s4Used: false } },
    });

    expect(regression.status).toBe(409);
    const rejected = httpErrorSchema.parse(await regression.json());
    expect(rejected.message).toContain("罠");
    expect(rejected.code).toBe("trap-regression");
    const state = await load("500006");
    expect(state.checkpoint?.revision).toBe(1);
    expect(state.checkpoint?.body.trap).toEqual({ s3Used: true, s4Used: false });
    expect(state.checkpoint?.body.pos).toBe(2);
  });

  it("経過時間を巻き戻す保存は409で拒否し、保存されない", async () => {
    await save("500017", {
      commandId: id("117"),
      expectedRevision: 0,
      body: { elapsedMs: 60_000 },
    });

    const regression = await save("500017", {
      commandId: id("118"),
      expectedRevision: 1,
      body: { pos: 6, elapsedMs: 30_000 },
    });

    expect(regression.status).toBe(409);
    const rejected = httpErrorSchema.parse(await regression.json());
    expect(rejected.message).toContain("経過時間");
    expect(rejected.code).toBe("elapsed-regression");
    const state = await load("500017");
    expect(state.checkpoint).toMatchObject({ revision: 1, body: { elapsedMs: 60_000, pos: 2 } });
  });

  it("進行位置を巻き戻す保存は409で拒否し、保存されない", async () => {
    await save("500019", { commandId: id("121"), expectedRevision: 0, body: { pos: 4 } });

    const regression = await save("500019", {
      commandId: id("122"),
      expectedRevision: 1,
      body: { pos: 3, elapsedMs: 120_000 },
    });

    expect(regression.status).toBe(409);
    const rejected = httpErrorSchema.parse(await regression.json());
    expect(rejected.message).toContain("進行位置");
    expect(rejected.code).toBe("pos-regression");
    const state = await load("500019");
    expect(state.checkpoint).toMatchObject({ revision: 1, body: { pos: 4, elapsedMs: 60_000 } });
  });

  it("同じposのままviewだけ切り替える保存はできる", async () => {
    await save("500020", {
      commandId: id("123"),
      expectedRevision: 0,
      body: { pos: 4, view: "stage3-quiz" },
    });

    const next = await save(
      "500020",
      {
        commandId: id("124"),
        expectedRevision: 1,
        body: { pos: 4, view: "stage3-manual" },
      },
      later,
    );

    expect(next.status).toBe(200);
    await expect(load("500020")).resolves.toMatchObject({
      checkpoint: { revision: 2, body: { pos: 4, view: "stage3-manual" } },
    });
  });

  it("経過時間が同値なら保存できる", async () => {
    await save("500018", {
      commandId: id("119"),
      expectedRevision: 0,
      body: { elapsedMs: 60_000 },
    });

    const next = await save(
      "500018",
      { commandId: id("120"), expectedRevision: 1, body: { pos: 4, elapsedMs: 60_000 } },
      later,
    );

    expect(next.status).toBe(200);
    await expect(load("500018")).resolves.toMatchObject({
      checkpoint: { revision: 2, body: { pos: 4, elapsedMs: 60_000 } },
    });
  });

  it("罠の状態を保ったまま次のチェックポイントは保存できる", async () => {
    await save("500007", {
      commandId: id("108"),
      expectedRevision: 0,
      body: { trap: { s3Used: true, s4Used: false } },
    });

    const next = await save(
      "500007",
      {
        commandId: id("109"),
        expectedRevision: 1,
        body: { pos: 3, trap: { s3Used: true, s4Used: true } },
      },
      later,
    );

    expect(next.status).toBe(200);
    const state = await load("500007");
    expect(state.checkpoint).toMatchObject({ revision: 2, savedAt: later, body: { pos: 3 } });
  });

  it("dataが上限を超える保存は400で拒否し、保存されない", async () => {
    const response = await save("500008", {
      commandId: id("110"),
      expectedRevision: 0,
      body: { data: { blob: "x".repeat(64 * 1024) } },
    });

    expect(response.status).toBe(400);
    expect(httpErrorSchema.parse(await response.json()).message).toContain("大きすぎます");
    await expect(load("500008")).resolves.toMatchObject({ checkpoint: null });
  });

  it.each([
    { label: "viewの不正文字", body: { view: "Stage_3" } },
    { label: "posの範囲外", body: { pos: 8 } },
    { label: "elapsedMsの負値", body: { elapsedMs: -1 } },
  ])("$labelは400で拒否し、保存されない", async ({ body: overrides }) => {
    const teamCode = "500009";
    const response = await save(teamCode, {
      commandId: id("111"),
      expectedRevision: 0,
      rawBody: { ...body(), ...overrides },
    });

    expect(response.status).toBe(400);
    expect(httpErrorSchema.parse(await response.json()).message).not.toContain("大きすぎます");
    await expect(load(teamCode)).resolves.toMatchObject({ checkpoint: null });
  });

  it("JSONにならない数値（1e400）を含む保存は400で拒否し、保存されない", async () => {
    // JSON.stringifyでは作れない値なので、本文を生のJSONテキストで組み立てる。
    const raw = `{"type":"save-checkpoint","commandId":"${id("125")}","expectedRevision":0,"body":{"view":"stage3-manual","pos":2,"elapsedMs":60000,"trap":{"s3Used":false,"s4Used":false},"data":{"score":1e400}}}`;
    const response = await handleSaveCheckpoint(
      new Request("https://example.test/api/teams/500021/checkpoint", {
        method: "POST",
        body: raw,
      }),
      env,
      "500021",
      now,
    );

    expect(response.status).toBe(400);
    expect(httpErrorSchema.parse(await response.json()).message).not.toContain("大きすぎます");
    await expect(load("500021")).resolves.toMatchObject({ checkpoint: null });
  });

  it("入れ子のdataは保存して復元しても同じ形で返る", async () => {
    const data = { quiz: { answers: ["A", "B"], done: true }, notes: [1, null, { memo: "x" }] };
    const response = await save("500022", {
      commandId: id("126"),
      expectedRevision: 0,
      body: { data },
    });

    expect(response.status).toBe(200);
    const state = await load("500022");
    expect(state.checkpoint?.body.data).toEqual(data);
  });

  it("深すぎるdataは例外にならず400で拒否し、保存されない", async () => {
    // 再帰schemaへ渡すとRangeErrorになる深さ。500エラーではなく400になることを固定する。
    let deep: unknown = [];
    for (let level = 0; level < 5000; level += 1) deep = [deep];
    const response = await save("500024", {
      commandId: id("129"),
      expectedRevision: 0,
      body: { data: { deep } },
    });

    expect(response.status).toBe(400);
    expect(httpErrorSchema.parse(await response.json()).message).not.toContain("大きすぎます");
    await expect(load("500024")).resolves.toMatchObject({ checkpoint: null });
  });

  it("JSONとして壊れた本文は400で拒否する", async () => {
    const response = await handleSaveCheckpoint(
      new Request("https://example.test/api/teams/500010/checkpoint", {
        method: "POST",
        body: "{",
      }),
      env,
      "500010",
      now,
    );

    expect(response.status).toBe(400);
    await expect(load("500010")).resolves.toMatchObject({ checkpoint: null });
  });

  it("適用済みのcommandIdは、最新revisionで再送しても再適用されない", async () => {
    const teamCode = "500016";
    const commandIds = Array.from({ length: 21 }, (_, index) => id(String(200 + index)));
    for (const [index, commandId] of commandIds.entries()) {
      const response = await save(teamCode, {
        commandId,
        expectedRevision: index,
        body: { pos: Math.min(index, 7) },
      });
      expect(response.status).toBe(200);
    }

    // 台帳は剪定しない。1行あたり数十バイトなので、120分の研修では膨らまない。
    const rows = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) =>
      state.storage.sql
        .exec("SELECT count(*) AS count FROM processed_checkpoint_commands")
        .toArray(),
    );
    expect(rows[0]?.count).toBe(21);

    // 最古のcommandIdを最新revisionで再送しても、古いbodyは再適用されない。
    const stale = await save(teamCode, {
      commandId: commandIds[0],
      expectedRevision: 21,
      body: { pos: 0 },
    });
    expect(stale.status).toBe(409);
    expect(httpErrorSchema.parse(await stale.json()).code).toBe("conflict");
    await expect(load(teamCode)).resolves.toMatchObject({
      checkpoint: { revision: 21, body: { pos: 7 } },
    });

    // 直前の保存の再送は、状態を進めず現在のsnapshotを返す。
    const kept = await save(teamCode, { commandId: commandIds[20], expectedRevision: 20 });
    expect(kept.status).toBe(200);
    const { snapshot } = saveCheckpointResultSchema.parse(await kept.json());
    expect(snapshot).toMatchObject({ revision: 21, body: { pos: 7 } });
    await expect(load(teamCode)).resolves.toMatchObject({ checkpoint: snapshot });
  });

  it("チームごとにチェックポイントが分離される", async () => {
    await save("500011", { commandId: id("112"), expectedRevision: 0, body: { pos: 1 } });
    await save("500012", { commandId: id("113"), expectedRevision: 0, body: { pos: 6 } });

    const first = await load("500011");
    const second = await load("500012");
    expect(first.checkpoint).toMatchObject({ teamCode: "500011", body: { pos: 1 } });
    expect(second.checkpoint).toMatchObject({ teamCode: "500012", body: { pos: 6 } });
  });

  it("同じcommandIdでも別チームなら独立して保存できる", async () => {
    const shared = id("114");
    await save("500013", { commandId: shared, expectedRevision: 0, body: { pos: 1 } });
    const other = await save("500014", {
      commandId: shared,
      expectedRevision: 0,
      body: { pos: 4 },
    });

    expect(other.status).toBe(200);
    await expect(load("500014")).resolves.toMatchObject({
      checkpoint: { teamCode: "500014", body: { pos: 4 } },
    });
  });
});
