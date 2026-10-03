import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionRecord, sessionRecordKey } from "../src/session-record.js";
import { FakeKeyValueStorage } from "./fakes.js";

const DraftSchema = z.object({ openedAt: z.number(), text: z.string() });
const KEY = sessionRecordKey("Inbox", "123456");

const setup = () => {
  const storage = new FakeKeyValueStorage();
  return { storage, record: sessionRecord(storage, KEY, DraftSchema) };
};

describe("sessionRecordKey", () => {
  it("モック（hellInbox:*）と衝突しないよう hellVue を前に付け、チームコードで分ける", () => {
    expect(sessionRecordKey("Inbox", "123456")).toBe("hellVueInbox:123456");
    expect(sessionRecordKey("Inbox", "654321")).not.toBe(KEY);
  });
});

describe("sessionRecord", () => {
  it("書いたものをそのまま読み戻す。無ければ null", () => {
    const { record } = setup();
    expect(record.read()).toBeNull();
    record.write({ openedAt: 5, text: "承知しました" });
    expect(record.read()).toEqual({ openedAt: 5, text: "承知しました" });
  });

  it("clear で消える", () => {
    const { storage, record } = setup();
    record.write({ openedAt: 5, text: "" });
    record.clear();
    expect(record.read()).toBeNull();
    expect(storage.values.has(KEY)).toBe(false);
  });

  it.each([
    ["JSON でない", "{openedAt"],
    ["形が違う", JSON.stringify({ openedAt: "5", text: "x" })],
    ["欄が足りない", JSON.stringify({ openedAt: 5 })],
    ["null", "null"],
    ["空文字", ""],
  ])("保存が壊れていたら（%s）捨てて null を返す", (_, stored) => {
    const { storage, record } = setup();
    storage.values.set(KEY, stored);
    expect(record.read()).toBeNull();
    expect(storage.values.has(KEY)).toBe(false);
  });

  it("壊れた値を捨てても、ほかのキーには触れない", () => {
    const { storage, record } = setup();
    storage.values.set(KEY, "broken");
    storage.values.set("hellInbox:123456", "mock's");
    record.read();
    expect(storage.values.get("hellInbox:123456")).toBe("mock's");
  });

  it("保存領域が使えなくても例外を出さない（読めば null、書いても何も起きない）", () => {
    const { storage, record } = setup();
    storage.failing = true;
    expect(record.read()).toBeNull();
    expect(() => {
      record.write({ openedAt: 1, text: "x" });
    }).not.toThrow();
    expect(() => {
      record.clear();
    }).not.toThrow();
    storage.failing = false;
    expect(record.read()).toBeNull();
  });
});
