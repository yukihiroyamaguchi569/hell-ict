import { exports } from "cloudflare:workers";
import { DEADLINE_GRACE_MS, INBOX_LIMIT_MS, S5_FEVER_IDS } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";

import {
  advance,
  applied,
  CLEAR,
  command,
  dumpTeamRoom,
  playTo,
  postCommand,
  replySchema,
  send,
  STAGE3_OK,
  STAGE3_TRAP,
  STAGE5_LIST,
} from "./game-command-support.js";
import { clock, countRows, gameOf, gmReset } from "./game-support.js";
import { postJson, session, TEST_ORIGIN } from "./support.js";
import { SECOND_NAME_JOINED, SECOND_PATIENT, SECOND_SURNAME } from "./pii-support.js";

beforeEach(() => {
  clock.reset();
});

describe("ルーティング（exports.default.fetch経由）", () => {
  it("POST /game/commands はコマンドを適用する", async () => {
    const response = await postJson("/api/teams/820001/game/commands", command("inbox.open"));
    expect(response.status).toBe(200);
    expect(replySchema.parse(await response.json())).toMatchObject({
      status: "applied",
      events: [],
      judgement: null,
    });
  });

  it("形の違う本文・未知のコマンドは400で、台帳にも状態にも何も書かない", async () => {
    for (const body of [
      { type: "inbox.open" },
      command("s9.win"),
      { ...command("inbox.open"), now: 0 },
      command("s3.submit", { submission: { ppe: "", release: "" } }),
    ]) {
      const response = await postJson("/api/teams/820002/game/commands", body);
      expect(response.status).toBe(400);
    }
    const broken = await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/teams/820002/game/commands`, {
        method: "POST",
        body: "{",
        headers: { Origin: TEST_ORIGIN },
      }),
    );
    expect(broken.status).toBe(400);
    expect((await gameOf("820002")).state.inbox).toBeNull();
    await expect(countRows("820002", "processed_game_commands")).resolves.toBe(0);
  });

  it("許可されていないOriginからのコマンドは403で、DOに何も書かない", async () => {
    const response = await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/teams/820003/game/commands`, {
        method: "POST",
        body: JSON.stringify(command("inbox.open")),
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect((await gameOf("820003")).state.inbox).toBeNull();
  });
});

describe("禁止された遷移", () => {
  it("未クリアの前進・飛ばし・後退・別ステージの操作を拒否し、状態も台帳も動かさない", async () => {
    const teamCode = "830001";
    await playTo(teamCode, "s3");
    const before = await gameOf(teamCode);
    const ledger = await countRows(teamCode, "processed_game_commands");
    for (const [body, reason] of [
      [advance("s3", "s4"), "not-cleared"],
      [advance("s3", "s5"), "skip-forbidden"],
      [advance("s3", "s2"), "not-forward"],
      [advance("s2", "s3"), "stage-mismatch"],
      [command("s5.submit", { text: STAGE5_LIST }), "stage-mismatch"],
      [command("s1.start"), "stage-mismatch"],
      [command("s3.finish-penalty"), "no-penalty-in-progress"],
    ] as const) {
      expect(await send(teamCode, body)).toMatchObject({ status: "rejected", reason });
    }
    expect((await gameOf(teamCode)).state).toEqual(before.state);
    await expect(countRows(teamCode, "processed_game_commands")).resolves.toBe(ledger);
  });
});

describe("罰の実施中は前進できない（Issue #92）", () => {
  const trap = async (teamCode: string): Promise<void> => {
    await playTo(teamCode, "s3");
    const reply = await applied(teamCode, command("s3.submit", { submission: STAGE3_TRAP }));
    expect(reply.events?.map((event) => event.type)).toEqual(["trap-triggered"]);
    expect(reply.judgement).toEqual({ outcome: "trap", field: "ppe" });
    expect(reply.state.game.penalties.s3).toBe("in-progress");
  };

  it("罠を踏んだ後は、正解の提出も前進も拒否される。罰を終えれば進める", async () => {
    const teamCode = "840001";
    await trap(teamCode);
    expect(await send(teamCode, command("s3.submit", { submission: STAGE3_OK }))).toMatchObject({
      status: "rejected",
      reason: "penalty-in-progress",
    });
    expect(await send(teamCode, advance("s3", "s4"))).toMatchObject({
      status: "rejected",
      reason: "penalty-in-progress",
    });
    await applied(teamCode, command("s3.finish-penalty"));
    await applied(teamCode, command("s3.submit", { submission: STAGE3_OK }));
    await applied(teamCode, advance("s3", "s4"));
  });

  it("2つのタブが罰の最中に並行して正解・前進を送っても、どれも通らない", async () => {
    const teamCode = "840002";
    await trap(teamCode);
    const replies = await Promise.all([
      send(teamCode, command("s3.submit", { submission: STAGE3_OK })),
      send(teamCode, advance("s3", "s4")),
      send(teamCode, advance("s3", "s4")),
    ]);
    expect(replies.map((reply) => reply.reason)).toEqual([
      "penalty-in-progress",
      "penalty-in-progress",
      "penalty-in-progress",
    ]);
    const view = await gameOf(teamCode);
    expect(view.state.game.stage).toBe("s3");
    expect(view.state.game.clearedAt.s3).toBeUndefined();
  });

  it("片方のタブが罰を終える間に、もう片方が前進を送っても、クリア前には進めない", async () => {
    const teamCode = "840003";
    await trap(teamCode);
    const [paid, forward] = await Promise.all([
      send(teamCode, command("s3.finish-penalty")),
      send(teamCode, advance("s3", "s4")),
    ]);
    expect(paid.status).toBe("applied");
    expect(forward.status).toBe("rejected");
    expect(["penalty-in-progress", "not-cleared"]).toContain(forward.reason);
    expect((await gameOf(teamCode)).state.game.stage).toBe("s3");
  });

  it("片方のタブが罠、もう片方が正解を同時に送ると、どちらの順でも罰を踏み倒せない", async () => {
    const teamCode = "840004";
    await playTo(teamCode, "s3");
    await Promise.all([
      send(teamCode, command("s3.submit", { submission: STAGE3_TRAP })),
      send(teamCode, command("s3.submit", { submission: STAGE3_OK })),
    ]);
    const forward = await send(teamCode, advance("s3", "s4"));
    const view = await gameOf(teamCode);
    if (view.state.game.penalties.s3 === "in-progress") {
      // 罠が先: 正解は罰の最中で拒否され、前進もできない。
      expect(forward).toMatchObject({ status: "rejected", reason: "penalty-in-progress" });
      expect(view.state.game.stage).toBe("s3");
    } else {
      // 正解が先: クリア済みなので罠は拒否され、罰は発生しない。
      expect(view.state.game.penalties.s3).toBe("none");
      expect(forward.status).toBe("applied");
    }
  });

  it("2つのタブが同時に前進しても、1つ先へ1回だけ進む", async () => {
    const teamCode = "840005";
    await playTo(teamCode, "s3");
    await CLEAR.s3?.(teamCode);
    const replies = await Promise.all([
      send(teamCode, advance("s3", "s4")),
      send(teamCode, advance("s3", "s4")),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual(["applied", "rejected"]);
    expect(replies.find((reply) => reply.status === "rejected")?.reason).toBe("stage-mismatch");
    expect((await gameOf(teamCode)).state.game.stage).toBe("s4");
  });
});

describe("同じcommandIdの再送", () => {
  it("2回目は状態を動かさず、最初の判定とeventsを返す", async () => {
    const teamCode = "850001";
    await playTo(teamCode, "s3");
    const body = command("s3.submit", { submission: STAGE3_OK });
    const first = await applied(teamCode, body);
    const ledger = await countRows(teamCode, "processed_game_commands");
    clock.advanceBy(1_000);
    const second = await send(teamCode, body);
    expect(second.status).toBe("duplicate");
    expect(second.original).toEqual({ events: first.events, judgement: first.judgement });
    expect(second.state).toEqual(first.state);
    await expect(countRows(teamCode, "processed_game_commands")).resolves.toBe(ledger);
  });

  it("同じcommandIdを同時に2回送っても1回だけ適用する", async () => {
    const teamCode = "850002";
    await playTo(teamCode, "s3");
    const body = command("s3.submit", { submission: STAGE3_TRAP });
    const replies = await Promise.all([send(teamCode, body), send(teamCode, body)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual(["applied", "duplicate"]);
    // 罠は1回だけ: 2回目が適用されていればtrap-repeatedが積まれている。
    const duplicate = replies.find((reply) => reply.status === "duplicate");
    expect(duplicate?.original?.events.map((event) => event.type)).toEqual(["trap-triggered"]);
  });

  it("同じcommandIdで別の内容を送ると409で、何も変えない", async () => {
    const teamCode = "850003";
    await playTo(teamCode, "s3");
    const body = command("s3.submit", { submission: STAGE3_TRAP });
    await applied(teamCode, body);
    const before = await gameOf(teamCode);
    const response = await postCommand(teamCode, { ...body, submission: STAGE3_OK });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "conflict" });
    expect((await gameOf(teamCode)).state).toEqual(before.state);
  });

  it("拒否されたコマンドは台帳に残らず、条件が整えば同じcommandIdで通る", async () => {
    const teamCode = "850004";
    await playTo(teamCode, "s3");
    const body = advance("s3", "s4");
    expect(await send(teamCode, body)).toMatchObject({ status: "rejected", reason: "not-cleared" });
    await CLEAR.s3?.(teamCode);
    await applied(teamCode, body);
  });
});

describe("締切の境界（サーバの時計と2秒の猶予）", () => {
  it("受信トレイは締切から2秒未満なら返信でき、2秒で時間切れになる", async () => {
    const teamCode = "860001";
    await applied(teamCode, command("inbox.open"));
    clock.advanceBy(INBOX_LIMIT_MS + DEADLINE_GRACE_MS - 1);
    await applied(teamCode, command("inbox.reply", { mailId: "p0", text: "間に合った" }));
    expect(await send(teamCode, command("inbox.settle"))).toMatchObject({
      status: "rejected",
      reason: "mails-open",
    });
    clock.advanceBy(1);
    expect(
      await send(teamCode, command("inbox.reply", { mailId: "p1", text: "遅れた" })),
    ).toMatchObject({ status: "rejected", reason: "expired" });
    const settled = await applied(teamCode, command("inbox.settle"));
    expect(settled.events?.map((event) => event.type)).toEqual(["stage-cleared"]);
  });

  it("Stage 1のラウンドは、最後のメールの締切から2秒を過ぎて初めて終わる", async () => {
    const teamCode = "860002";
    await playTo(teamCode, "s1");
    await applied(teamCode, command("s1.start"));
    // 最後のメールは23秒で届き、60秒と猶予2秒のあいだ開いている。
    clock.advanceBy(85_000);
    expect(await send(teamCode, command("s1.settle"))).toMatchObject({
      status: "rejected",
      reason: "round-not-over",
    });
    clock.advanceBy(1);
    const failed = await applied(teamCode, command("s1.settle"));
    expect(failed.judgement).toEqual({ settlement: { type: "round-failed", failure: "round1" } });
    await applied(teamCode, command("s1.next-round"));
  });
});

describe("リセット世代", () => {
  it("GMリセットで台帳も消え、リセット前の世代のコマンドは409で何も書かない", async () => {
    const teamCode = "870001";
    await session(teamCode);
    await playTo(teamCode, "s2");
    await expect(countRows(teamCode, "processed_game_commands")).resolves.toBeGreaterThan(0);

    expect((await gmReset(teamCode)).status).toBe(200);
    await expect(countRows(teamCode, "game_state")).resolves.toBe(0);
    await expect(countRows(teamCode, "processed_game_commands")).resolves.toBe(0);

    const stale = await postCommand(teamCode, command("inbox.open", {}, 0));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale-generation" });
    await expect(countRows(teamCode, "game_state")).resolves.toBe(0);

    expect((await gameOf(teamCode)).state.game.stage).toBe("prologue");
    await applied(teamCode, command("inbox.open", {}, 1));
  });
});

describe("提出本文を保存しない（S5）", () => {
  it("AIへ送ろうとした個人情報は罠として記録するが、本文はDOのどのテーブルにも残らない", async () => {
    const teamCode = "880001";
    await playTo(teamCode, "s5");
    const trapped = await applied(
      teamCode,
      command("s5.check-ai-message", {
        text: `${SECOND_PATIENT.id}\t${SECOND_NAME_JOINED}\t${SECOND_PATIENT.ward}`,
      }),
    );
    expect(trapped.judgement).toEqual({ outcome: "trap", detected: "患者氏名" });
    expect(trapped.state.game.penalties.s5).toBe("in-progress");
    expect(await dumpTeamRoom(teamCode)).not.toContain(SECOND_SURNAME);
    expect(await send(teamCode, command("s5.submit", { text: STAGE5_LIST }))).toMatchObject({
      status: "rejected",
      reason: "penalty-in-progress",
    });
  });

  it("S6の指示に書いた個人情報は、DOに残すログでもGETの応答でも伏せ字になる", async () => {
    const teamCode = "880003";
    await playTo(teamCode, "s6");
    await applied(
      teamCode,
      command("s6.generate", { prompt: `ピクトグラムで。${SECOND_NAME_JOINED}さんのご家族向けに` }),
    );
    expect(await dumpTeamRoom(teamCode)).not.toContain(SECOND_SURNAME);
    expect(JSON.stringify(await gameOf(teamCode))).not.toContain(SECOND_SURNAME);
  });

  it("適用されたS5の提出（差し戻し・合格）も本文は残さず、判定の詳細だけを残す", async () => {
    const teamCode = "880002";
    await playTo(teamCode, "s5");
    const withName = `${STAGE5_LIST}\n備考\t${SECOND_NAME_JOINED}`;
    const missingOne = withName
      .split("\n")
      .filter((line) => !line.startsWith(`${S5_FEVER_IDS[0] ?? ""}\t`))
      .join("\n");
    const rejected = await applied(teamCode, command("s5.submit", { text: missingOne }));
    expect(rejected.events?.map((event) => event.type)).toEqual(["submission-rejected"]);
    await applied(teamCode, command("s5.submit", { text: withName }));
    const dump = await dumpTeamRoom(teamCode);
    expect(dump).not.toContain("最高体温");
    expect(dump).not.toContain(SECOND_SURNAME);
  });
});
