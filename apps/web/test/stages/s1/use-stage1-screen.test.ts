import { sendStage1Reply } from "@hell-ict/domain";
import type { Stage1State } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { computed, effectScope, nextTick, ref } from "vue";

import { useMailSelection } from "../../../src/inbox/use-stage-inbox.js";
import type { ClipboardPort } from "../../../src/ports.js";
import { useStage1 } from "../../../src/stages/s1/use-stage1.js";
import type { Stage1Draft } from "../../../src/stages/s1/use-stage1-draft.js";
import {
  STAGE1_BRIEF_BEATS,
  STAGE1_FLASH_MS,
  useStage1Screen,
} from "../../../src/stages/s1/use-stage1-screen.js";
import { FakeKeyValueStorage, FakeScheduler, flush } from "../../fakes.js";
import { appliedWith, fakeSession, stage1, T0, viewIn } from "./fake-session.js";
import type { Answer } from "./fake-session.js";

/** The reply boxes as the screen sees them: a body per mail and the memo. */
const fakeDraft = (): Stage1Draft => {
  const bodies = ref<Record<string, string>>({});
  const text = ref("");
  const box = computed({
    get: () => text.value,
    set: (value: string) => {
      text.value = value;
    },
  });
  return {
    context: box,
    memo: box,
    body: (id) => bodies.value[id] ?? "",
    setBody: (id, value) => {
      bodies.value = { ...bodies.value, [id]: value };
    },
    point: () => "",
    setPoint: () => undefined,
    label: () => "",
    busy: () => false,
    draft: () => Promise.resolve({ kind: "closed" }),
  };
};

const mount = (
  s1: Stage1State | null,
  answer: Answer = (command) => appliedWith(viewIn(command.type === "s1.start" ? stage1() : s1)),
  clipboard: ClipboardPort = { writeText: () => Promise.resolve() },
) => {
  const fake = fakeSession(viewIn(s1), answer);
  const scheduler = new FakeScheduler();
  const mail = useMailSelection();
  const draft = fakeDraft();
  const scope = effectScope();
  const screen = scope.run(() => {
    const context = {
      session: fake.session,
      serverNow: ref(T0 + 30_000),
      sessionStorage: new FakeKeyValueStorage(),
      scheduler,
      mail,
      sfx: { play: () => undefined },
      karubeRead: ref(new Set<string>()),
      teamName: ref(""),
    };
    return useStage1Screen({ context, stage: useStage1(context), draft, clipboard });
  });
  if (screen === undefined) throw new Error("the scope did not run");
  return { ...fake, screen, scheduler, mail, draft, scope };
};

describe("useStage1Screen: ブリーフィング", () => {
  it("段落は順に出て、最後の拍でボタンが押せる。どこかを押せば残りが一度に出る", () => {
    const { screen, scheduler } = mount(null);
    expect(screen.mode.value).toBe("waiting");
    scheduler.advanceBy(0);
    expect(screen.beats.value).toBe(1);
    scheduler.advanceBy(1_200);
    expect(screen.beats.value).toBe(3);
    screen.showAllBeats();
    expect(screen.beats.value).toBe(STAGE1_BRIEF_BEATS.length);
  });

  it("［了解しました］の連打でも s1.start は1回", async () => {
    const { screen, types } = mount(null);
    await Promise.all([screen.begin(), screen.begin()]);
    expect(types()).toEqual(["s1.start"]);
    expect(screen.busy.value).toBe(false);
  });

  it("開始済みなら拍を刻まない（再読み込み後にブリーフィングを出し直さない）", () => {
    const { screen, scheduler } = mount(stage1());
    expect(scheduler.pending).toBe(0);
    expect(screen.mode.value).toBe("idle");
  });
});

describe("useStage1Screen: 返信", () => {
  it("空欄は送らず、ボタンの文言だけ 1600ms 変わる", async () => {
    const { screen, mail, scheduler, types } = mount(stage1());
    mail.open("m1");
    await screen.send();
    expect(types()).toEqual([]);
    expect(screen.sendLabel.value).toBe("本文が空です");
    scheduler.advanceBy(STAGE1_FLASH_MS - 1);
    expect(screen.sendLabel.value).toBe("本文が空です");
    scheduler.advanceBy(1);
    expect(screen.sendLabel.value).toBe("送信する");
  });

  it("送れたメールは閉じて、ログに「返信した」が付く（メモリだけ）", async () => {
    const done = sendStage1Reply(stage1(), "m1", "はい", T0 + 1_000).state;
    const { screen, mail, draft, sent } = mount(stage1(), () => appliedWith(viewIn(done)));
    mail.open("m1");
    expect(screen.mode.value).toBe("mail");
    expect(screen.mail.value?.from).toBe("3B病棟 看護師");
    draft.setBody("m1", "はい");
    await screen.send();
    await nextTick();
    expect(sent).toEqual([{ type: "s1.reply", mailId: "m1", text: "はい" }]);
    expect(mail.openId.value).toBeNull();
    expect(screen.log.value).toEqual(["返信した　サージカルマスクの在庫について"]);
  });

  it("メモは同じ欄から s1.memo-reply で送る", async () => {
    const { screen, mail, draft, types } = mount(stage1());
    mail.open("memo");
    expect(screen.mode.value).toBe("memo");
    expect(screen.mailId.value).toBeNull();
    draft.memo.value = "ありがとうございました";
    await screen.send();
    expect(types()).toEqual(["s1.memo-reply"]);
  });
});

describe("useStage1Screen: メモのコピー", () => {
  it("書けたら「コピーしました」。書けなくても投げず、文言は変えない", async () => {
    const copied: string[] = [];
    const ok = mount(stage1(), undefined, {
      writeText: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    await ok.screen.copyMemo();
    expect(copied[0]).toContain("総務課");
    expect(ok.screen.copyLabel.value).toBe("コピーしました");

    const refused = mount(stage1(), undefined, {
      writeText: () => Promise.reject(new Error("denied")),
    });
    await refused.screen.copyMemo();
    await flush();
    expect(refused.screen.copyLabel.value).toBe("本文をコピー");
  });
});

describe("useStage1Screen: 結果窓", () => {
  it("失敗したラウンドだけ窓を出し、ボタンで s1.next-round を1回", async () => {
    const failed = stage1({ status: { phase: "round-result", failure: "round1" } });
    const { screen, types } = mount(failed, () => appliedWith(viewIn(stage1({ round: 2 }))));
    expect(screen.roundEnd.value?.heading).toBe("1回目、終了");
    await Promise.all([screen.nextRound(), screen.nextRound()]);
    expect(types()).toEqual(["s1.next-round"]);
    expect(screen.roundEnd.value).toBeNull();
    expect(screen.aiReady.value).toBe(true);
  });
});
