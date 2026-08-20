import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("開発ハーネスWorker", () => {
  it("外部JSONをruntime schemaで検証する", async () => {
    const accepted = await exports.default.fetch(
      new Request("https://example.test/api/echo", {
        body: JSON.stringify({ message: "  接続確認  " }),
        method: "POST",
      }),
    );
    const rejected = await exports.default.fetch(
      new Request("https://example.test/api/echo", { body: "{}", method: "POST" }),
    );

    await expect(accepted.json()).resolves.toEqual({ message: "接続確認" });
    expect(rejected.status).toBe(400);
  });

  it("Durable Objectをローカル実行環境で永続化する", async () => {
    const counter = env.HARNESS_COUNTER.getByName("singleton");

    await expect(counter.increment()).resolves.toBe(1);
    await expect(counter.increment()).resolves.toBe(2);
  });
});
