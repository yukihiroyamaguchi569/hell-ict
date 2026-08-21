import { describe, expect, it } from "vitest";

import { httpErrorSchema } from "../../src/schemas/http-error.js";

describe("HTTPエラー応答schema", () => {
  it("messageを持つオブジェクトを受理する", () => {
    expect(
      httpErrorSchema.parse({ message: "個人情報を検知したため、送信をブロックしました。" }),
    ).toEqual({
      message: "個人情報を検知したため、送信をブロックしました。",
    });
  });

  it("未知のフィールド、message欠落、非オブジェクトを拒否する", () => {
    for (const input of [{ message: "本文", extra: true }, {}, { message: 1 }, null, []]) {
      expect(httpErrorSchema.safeParse(input).success).toBe(false);
    }
  });
});
