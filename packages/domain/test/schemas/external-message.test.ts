import { describe, expect, it } from "vitest";

import { parseExternalMessage } from "../../src/index.js";

describe("parseExternalMessage", () => {
  it("外部入力を検証してドメイン型へ変換する", () => {
    expect(parseExternalMessage({ message: "  確認してください。  " })).toEqual({
      message: "確認してください。",
    });
  });

  it.each([undefined, null, {}, { message: "" }, { message: "x".repeat(281) }])(
    "不正な外部入力を拒否する: %j",
    (input) => {
      expect(() => parseExternalMessage(input)).toThrow();
    },
  );
});
