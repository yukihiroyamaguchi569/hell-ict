import { describe, expect, it } from "vitest";

import { DEADLINE_GRACE_MS } from "../../src/stages/deadline.js";
import {
  INBOX_LIMIT_MS,
  inboxSettleAt,
  judgePrologue,
  sendInboxReply,
  startInbox,
} from "../../src/stages/inbox.js";

const T0 = 1_790_000_000_000;

describe("inboxSettleAt（画面が inbox.settle を送る時刻）", () => {
  it("開いてから5分と猶予の後", () => {
    expect(inboxSettleAt(startInbox(T0))).toBe(T0 + INBOX_LIMIT_MS + DEADLINE_GRACE_MS);
  });

  it("その時刻ちょうどでサーバは完了とみなし、1ms 前はまだ受け付けない", () => {
    const state = startInbox(T0);
    expect(judgePrologue(state, inboxSettleAt(state))).toEqual({ outcome: "pass" });
    expect(judgePrologue(state, inboxSettleAt(state) - 1).outcome).toBe("reject");
  });

  it("返信の有無で動かない（起点は開いた時刻だけ）", () => {
    const replied = sendInboxReply(startInbox(T0), "p1", "はい", T0 + 1_000).state;
    expect(inboxSettleAt(replied)).toBe(inboxSettleAt(startInbox(T0)));
  });
});
