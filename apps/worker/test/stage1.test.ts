import { env } from "cloudflare:workers";
import {
  commandResultSchema,
  STAGE1_ROUND1_DEADLINE_MS,
  STAGE1_ROUND1_EMAILS,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import { FakeClock } from "@hell-ict/domain/fakes";
import type { CommandResult } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { handleCommand } from "../src/index.js";
import { collectMessages, session, upgrade } from "./support.js";

const enterStage1 = (teamCode: string, commandId: string, clock: FakeClock): Promise<Response> =>
  handleCommand(
    new Request(`https://example.test/api/teams/${teamCode}/commands`, {
      method: "POST",
      body: JSON.stringify({ type: "enter-stage1", commandId, expectedRevision: 0 }),
    }),
    env,
    teamCode,
    clock,
  );

const submitReply = (
  teamCode: string,
  command: { commandId: string; expectedRevision: number; emailId: string; text: string },
  clock: FakeClock,
): Promise<Response> =>
  handleCommand(
    new Request(`https://example.test/api/teams/${teamCode}/commands`, {
      method: "POST",
      body: JSON.stringify({ type: "submit-stage1-reply", ...command }),
    }),
    env,
    teamCode,
    clock,
  );

const firstEmail = STAGE1_ROUND1_EMAILS[0];
if (firstEmail === undefined) throw new Error("unexpected");

describe("Stage 1 ラウンド1の返信コマンド（Worker統合）", () => {
  it("Clockの配線どおり、締切1ms前は通り1ms後はemail-expiredで409になる", async () => {
    await session("600000");
    const roundStartEpoch = new Date("2026-08-21T00:00:00.000Z").getTime();
    const clock = new FakeClock(new Date(roundStartEpoch));
    const entered = await enterStage1("600000", "00000000-0000-4000-8000-000000000001", clock);
    const { snapshot } = commandResultSchema.parse(await entered.json());

    const firstDeadline = roundStartEpoch + firstEmail.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS;
    clock.advanceBy(firstDeadline - 1 - clock.now().getTime());
    const onTime = await submitReply(
      "600000",
      {
        commandId: "00000000-0000-4000-8000-000000000002",
        expectedRevision: snapshot.revision,
        emailId: firstEmail.id,
        text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
      },
      clock,
    );
    expect(onTime.status).toBe(200);
    const onTimeResult = commandResultSchema.parse(await onTime.json());

    const secondEmail = STAGE1_ROUND1_EMAILS[1];
    if (secondEmail === undefined) throw new Error("unexpected");
    const secondDeadline =
      roundStartEpoch + secondEmail.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS;
    clock.advanceBy(secondDeadline - clock.now().getTime());
    const late = await submitReply(
      "600000",
      {
        commandId: "00000000-0000-4000-8000-000000000003",
        expectedRevision: onTimeResult.snapshot.revision,
        emailId: secondEmail.id,
        text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
      },
      clock,
    );
    expect(late.status).toBe(409);
  });

  it("同一commandIdの再送は保存済み結果を返す", async () => {
    await session("600001");
    const clock = new FakeClock(new Date("2026-08-21T00:00:00.000Z"));
    await enterStage1("600001", "00000000-0000-4000-8000-000000000101", clock);
    const command = {
      commandId: "00000000-0000-4000-8000-000000000102",
      expectedRevision: 1,
      emailId: firstEmail.id,
      text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
    };
    const first = await submitReply("600001", command, clock);
    clock.advanceBy(STAGE1_ROUND1_DEADLINE_MS * 10); // 再送時にはとっくに締切を過ぎていても結果は変わらない
    const repeated = await submitReply("600001", command, clock);
    const firstResult: CommandResult = commandResultSchema.parse(await first.json());
    const repeatedResult: CommandResult = commandResultSchema.parse(await repeated.json());
    expect(repeatedResult).toEqual(firstResult);
  });

  it("再接続後もstage1の返信状態が復元される", async () => {
    await session("600002");
    const clock = new FakeClock(new Date("2026-08-21T00:00:00.000Z"));
    await enterStage1("600002", "00000000-0000-4000-8000-000000000201", clock);
    await submitReply(
      "600002",
      {
        commandId: "00000000-0000-4000-8000-000000000202",
        expectedRevision: 1,
        emailId: firstEmail.id,
        text: "承知しました。担当に確認のうえ、折り返しご連絡いたします。",
      },
      clock,
    );

    const response = await upgrade("/api/teams/600002/sync");
    const [envelope] = await collectMessages(response, 1);
    const parsed = teamSyncMessageSchema.parse(envelope);
    expect(parsed.kind).toBe("team");
    if (parsed.kind !== "team") throw new Error("unexpected");
    expect(parsed.snapshot.state).toMatchObject({
      stage: "stage1",
      stage1: { replies: [{ emailId: firstEmail.id, polite: true }] },
    });
  });
});
