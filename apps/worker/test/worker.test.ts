import { exports } from "cloudflare:workers";
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
    const first = await exports.default.fetch(
      new Request("https://example.test/harness/increment", { method: "POST" }),
    );
    const second = await exports.default.fetch(
      new Request("https://example.test/harness/increment", { method: "POST" }),
    );

    await expect(first.json()).resolves.toEqual({ count: 1 });
    await expect(second.json()).resolves.toEqual({ count: 2 });
  });
});
