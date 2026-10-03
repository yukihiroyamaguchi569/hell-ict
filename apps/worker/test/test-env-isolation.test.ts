import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// vitest.config.tsの上書きが効いていることを確かめる。ローカルの.dev.varsに実キーが
// あっても、テストからOpenAIの実エンドポイントへ送信しない（Issue #252）。
describe("テスト環境のOpenAI設定", () => {
  it("宛先は到達しないループバックで、キーはダミーに差し替わっている", () => {
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:9");
    expect(env.OPENAI_API_KEY).toBe("test-dummy-openai-key");
  });
});
