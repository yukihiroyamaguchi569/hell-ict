import { describe, expect, it } from "vitest";

import { CHECKPOINT_REJECTION_REASONS } from "../../src/schemas/checkpoint.js";
import { httpErrorSchema } from "../../src/schemas/http-error.js";

describe("HTTPエラー応答schema", () => {
  it("messageを持つオブジェクトを受理する", () => {
    expect(
      httpErrorSchema.parse({ message: "個人情報を検知したため、送信をブロックしました。" }),
    ).toEqual({
      message: "個人情報を検知したため、送信をブロックしました。",
    });
  });

  it("codeを持つオブジェクトを受理する", () => {
    expect(httpErrorSchema.parse({ message: "本文", code: "pii_blocked" })).toEqual({
      message: "本文",
      code: "pii_blocked",
    });
  });

  it.each(CHECKPOINT_REJECTION_REASONS)("チェックポイントの拒否理由 %s をcodeに持てる", (code) => {
    expect(httpErrorSchema.parse({ message: "本文", code })).toEqual({ message: "本文", code });
  });

  it("未知のフィールド、message欠落、不正なcode、非オブジェクトを拒否する", () => {
    for (const input of [
      { message: "本文", extra: true },
      {},
      { message: 1 },
      { message: "本文", code: "unknown_code" },
      null,
      [],
    ]) {
      expect(httpErrorSchema.safeParse(input).success).toBe(false);
    }
  });
});
