import { STAGE2_AI_UNLOCK_DELAY_MS, STAGE2_DEADLINE_MS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope, ref } from "vue";

import { stageRegistry } from "../../../src/stages/registry.js";
import { stage2 } from "../../../src/stages/s2/index.js";
import { stage2AiCallId } from "../../../src/stages/s2/s2-ai.js";
import { s2Context, s2View, settle, T0 } from "./s2-fixtures.js";

const DEADLINE = T0 + STAGE2_DEADLINE_MS;

describe("stage2: 登録", () => {
  it("registry に載っている（準備中ではない）", () => {
    expect(stageRegistry.s2).toBe(stage2);
  });

  it("［表に追加］は追加分のビューアで、取り込める間だけ出る", async () => {
    const { context, serverNow } = s2Context(
      s2View({ startedAt: T0, addendumTakenAt: null }),
      undefined,
      {
        now: DEADLINE - 1,
      },
    );
    const instance = effectScope().run(() => stage2.setup(context));
    if (instance === undefined) throw new Error("the scope did not run");
    expect(instance.viewerToolbar?.("add")).toBeNull();
    expect(instance.inbox?.rows.value).toHaveLength(1);
    serverNow.value = DEADLINE;
    await settle();
    expect(instance.viewerToolbar?.("add")).not.toBeNull();
    expect(instance.viewerToolbar?.("main")).toBeNull();
    expect(instance.inbox?.rows.value).toHaveLength(2);
  });

  it("45 秒で苅部さんが鳴り、開くと右ペイン。台本の［表に送る］で20行が表に入る", async () => {
    const started = { startedAt: T0, addendumTakenAt: null };
    const { context, serverNow } = s2Context(s2View(started), undefined, {
      now: T0 + STAGE2_AI_UNLOCK_DELAY_MS - 1,
    });
    const read = ref<ReadonlySet<string>>(new Set());
    const { karube, rightPane, chatSubmit } =
      effectScope().run(() => stage2.setup({ ...context, karubeRead: read })) ?? {};
    if (!karube || !rightPane || !chatSubmit) throw new Error("the AI is not wired");
    await settle();
    expect(karube.value).toEqual([]);
    serverNow.value = T0 + STAGE2_AI_UNLOCK_DELAY_MS;
    expect(karube.value.map((call) => call.callId)).toEqual([stage2AiCallId(started)]);
    expect(rightPane.value).toBeNull();
    read.value = new Set([stage2AiCallId(started)]);
    expect(rightPane.value).toBe("shown");

    const { action } = chatSubmit("表をきれいにして");
    expect(action?.label).toBe("表に送る");
    action?.run();
    expect(context.sessionStorage.getItem("hellVueGrid:123456")).toContain('"001","5A"');
  });
});
