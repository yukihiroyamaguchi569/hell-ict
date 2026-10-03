import { chatMessageSchema } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { chatPaneItems } from "../../src/chat/pane-items.js";
import type { ChatNotice } from "../../src/chat/pane-items.js";
import { chatMessageBody } from "../fakes.js";

const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";

const messages = [
  chatMessageSchema.parse(chatMessageBody(1, "user", "質問")),
  chatMessageSchema.parse(chatMessageBody(2, "assistant", "回答")),
];

const notice = (id: number, after: number, threadId = S3): ChatNotice => ({
  id,
  threadId,
  text: `お知らせ${String(id)}`,
  after,
});

const labels = (items: ReturnType<typeof chatPaneItems>): string[] =>
  items.map((item) => ("text" in item ? item.text : item.kind));

describe("chatPaneItems", () => {
  it("何も無ければ挨拶だけ", () => {
    expect(chatPaneItems([], [], null, S3)).toEqual([{ kind: "greeting", key: "greeting" }]);
    expect(chatPaneItems([], [], null, null)).toEqual([{ kind: "greeting", key: "greeting" }]);
  });

  it("お知らせは言われた時点の位置に並ぶ（先頭・途中・末尾・件数より後ろ）", () => {
    const items = chatPaneItems(
      messages,
      [notice(1, 0), notice(2, 1), notice(3, 2), notice(4, 5)],
      null,
      S3,
    );
    expect(labels(items)).toEqual([
      "お知らせ1",
      "質問",
      "お知らせ2",
      "回答",
      "お知らせ3",
      "お知らせ4",
    ]);
  });

  it("別スレッドのお知らせと送信中の発言は出さない", () => {
    const items = chatPaneItems(
      [],
      [notice(1, 0, S4)],
      { threadId: S4, text: "前のステージの質問" },
      S3,
    );
    expect(items).toEqual([{ kind: "greeting", key: "greeting" }]);
  });

  it("送信中は自分の発言と「入力中」を末尾に出し、挨拶は出さない", () => {
    const items = chatPaneItems([], [], { threadId: S3, text: "質問" }, S3);
    expect(items).toEqual([
      { kind: "message", key: "in-flight", role: "user", text: "質問" },
      { kind: "typing", key: "typing" },
    ]);
  });

  it("スレッドが無いステージではお知らせも出さない", () => {
    expect(chatPaneItems([], [notice(1, 0)], null, null)).toEqual([
      { kind: "greeting", key: "greeting" },
    ]);
  });
});
