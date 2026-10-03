import { env } from "cloudflare:workers";
import { gameCommandResponseSchema, gameViewResponseSchema } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { handleGameState } from "../src/game-api.js";
import { command, playTo, postCommand, STAGE3_TRAP } from "./game-command-support.js";
import { clock } from "./game-support.js";

beforeEach(() => {
  clock.reset();
});

/**
 * 画面（apps/web）は応答をdomainのschemaで検証してから使う。Workerの出力がそのschemaを
 * 通ることをここで固定する——片方だけ形を変えると、画面は全応答を不正として捨ててしまう。
 */
describe("ゲームAPIの応答はdomainの応答schemaを通る", () => {
  it("GETと、applied・rejected・duplicateのコマンド応答（罠の後、ステージのAIあり）", async () => {
    const teamCode = "810901";
    await playTo(teamCode, "s3");

    const trap = command("s3.submit", { submission: STAGE3_TRAP });
    const applied = gameCommandResponseSchema.parse(
      await (await postCommand(teamCode, trap)).json(),
    );
    expect(applied.status).toBe("applied");
    expect(applied.state.game.penalties.s3).toBe("in-progress");

    const duplicate = gameCommandResponseSchema.parse(
      await (await postCommand(teamCode, trap)).json(),
    );
    expect(duplicate.status).toBe("duplicate");

    const rejected = gameCommandResponseSchema.parse(
      await (await postCommand(teamCode, command("advance", { from: "s3", to: "s4" }))).json(),
    );
    expect(rejected.status).toBe("rejected");

    const response = await handleGameState(env, teamCode, clock);
    expect(response.status).toBe(200);
    const view = gameViewResponseSchema.parse(await response.json());
    expect(view.pos).toBe(3);
    expect(view.ai.status).not.toBe("none");
  });
});
