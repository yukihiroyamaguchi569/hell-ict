import { describe, expect, it } from "vitest";
import { effectScope, nextTick, shallowRef } from "vue";

import { chatPaneItems, withScriptedTurns } from "../../src/chat/pane-items.js";
import {
  paneConversation,
  SCRIPTED_REPLY_DELAY_MS,
  useScriptedChat,
  type ChatSubmit,
  type ScriptedChat,
} from "../../src/chat/use-scripted-chat.js";
import { FakeScheduler } from "../fakes.js";

const GREETING = chatPaneItems([], [], null, null);

describe("withScriptedTurns", () => {
  it("台本のやり取りが無ければ、サーバの吹き出し（挨拶）をそのまま", () => {
    expect(withScriptedTurns(GREETING, [])).toBe(GREETING);
  });

  it("1つ目で挨拶を消し、返答待ちは「入力中」、返答は台本の吹き出しとボタン", () => {
    const run = () => undefined;
    const items = withScriptedTurns(GREETING, [
      { id: 0, text: "整えて", reply: { text: "表", action: { label: "表に送る", run } } },
      { id: 1, text: "もう一度", reply: null },
    ]);
    expect(items).toEqual([
      { kind: "message", key: "scripted-0-me", role: "user", text: "整えて" },
      { kind: "scripted", key: "scripted-0", text: "表", action: { label: "表に送る", run } },
      { kind: "message", key: "scripted-1-me", role: "user", text: "もう一度" },
      { kind: "typing", key: "scripted-1-typing" },
    ]);
  });

  it("ボタンの無い返答は action が null", () => {
    const [, reply] = withScriptedTurns(GREETING, [{ id: 0, text: "a", reply: { text: "b" } }]);
    expect(reply).toEqual({ kind: "scripted", key: "scripted-0", text: "b", action: null });
  });

  it("待ちの文言があれば「入力中」の代わりに出し、返答の画像は吹き出しへ渡す（Stage 6）", () => {
    const image = { src: "/posters/a.png", alt: "標準案" };
    const items = withScriptedTurns(GREETING, [
      { id: 0, text: "作って", reply: { text: "", image } },
      { id: 1, text: "直して", reply: null, waitingText: "画像を生成しています…" },
    ]);
    expect(items).toEqual([
      { kind: "message", key: "scripted-0-me", role: "user", text: "作って" },
      { kind: "scripted", key: "scripted-0", text: "", action: null, image },
      { kind: "message", key: "scripted-1-me", role: "user", text: "直して" },
      { kind: "waiting", key: "scripted-1-typing", text: "画像を生成しています…" },
    ]);
  });

  it("待ち時間のある待ちだけがバーの長さを持つ（入力中と、文言だけの待ちには付かない）", () => {
    const items = withScriptedTurns(GREETING, [
      { id: 0, text: "a", reply: null },
      { id: 1, text: "b", reply: null, waitingText: "待って" },
      { id: 2, text: "c", reply: null, waitingText: "生成中", waitingMs: 2_500 },
      { id: 3, text: "d", reply: null, waitingText: "即", waitingMs: 0 },
    ]);
    expect(items.filter((item) => item.kind !== "message")).toEqual([
      { kind: "typing", key: "scripted-0-typing" },
      { kind: "waiting", key: "scripted-1-typing", text: "待って" },
      { kind: "waiting", key: "scripted-2-typing", text: "生成中", progressMs: 2_500 },
      { kind: "waiting", key: "scripted-3-typing", text: "即", progressMs: 0 },
    ]);
  });

  it("返答が来た待ちにはバーが残らない", () => {
    const items = withScriptedTurns(GREETING, [
      { id: 0, text: "a", reply: { text: "b" }, waitingText: "生成中", waitingMs: 2_500 },
    ]);
    expect(items.some((item) => "progressMs" in item)).toBe(false);
  });
});

describe("paneConversation", () => {
  const scripted: ScriptedChat = { turns: shallowRef([]), send: () => undefined };
  const own: ScriptedChat = { turns: shallowRef([]), send: () => undefined };
  const submit: ChatSubmit = (text) => ({ text });

  it("ステージが会話を持てば、chatSubmit の有無に関わらずそれを描く", () => {
    expect(paneConversation(own, submit, scripted)).toBe(own);
    expect(paneConversation(own, undefined, scripted)).toBe(own);
  });

  it("会話を持たず chatSubmit だけなら台本の会話、どちらも無ければ null（サーバのAIへ送る）", () => {
    expect(paneConversation(undefined, submit, scripted)).toBe(scripted);
    expect(paneConversation(undefined, undefined, scripted)).toBeNull();
  });
});

const mount = (initial: ChatSubmit | undefined) => {
  const submit = shallowRef(initial);
  const scheduler = new FakeScheduler();
  const scope = effectScope();
  const chat = scope.run(() => useScriptedChat(() => submit.value, scheduler));
  if (chat === undefined) throw new Error("the scope did not run");
  return { chat, submit, scheduler, scope };
};

describe("useScriptedChat", () => {
  it("送ると「入力中」になり、1100ms ちょうどでステージに聞いて返答が付く", () => {
    const asked: string[] = [];
    const { chat, scheduler } = mount((text) => {
      asked.push(text);
      return { text: `返答:${text}` };
    });
    chat.send("整えて");
    expect(chat.turns.value).toEqual([{ id: 0, text: "整えて", reply: null }]);
    scheduler.advanceBy(SCRIPTED_REPLY_DELAY_MS - 1);
    expect(asked).toEqual([]);
    scheduler.advanceBy(1);
    expect(asked).toEqual(["整えて"]);
    expect(chat.turns.value[0]?.reply).toEqual({ text: "返答:整えて" });
  });

  it("口の無いステージでは何も起きない", () => {
    const { chat, scheduler } = mount(undefined);
    chat.send("整えて");
    expect(chat.turns.value).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it("ステージが変わったら会話を空にし、待っている返答は出さない", async () => {
    const asked: string[] = [];
    const { chat, submit, scheduler } = mount((text) => {
      asked.push(text);
      return { text };
    });
    chat.send("整えて");
    submit.value = () => ({ text: "別" });
    await nextTick();
    expect(chat.turns.value).toEqual([]);
    scheduler.advanceBy(SCRIPTED_REPLY_DELAY_MS);
    expect(asked).toEqual([]);
    expect(chat.turns.value).toEqual([]);
  });

  it("画面を離れたら（scope の停止）待っている返答を取り消す", () => {
    const { chat, scheduler, scope } = mount(() => ({ text: "返答" }));
    chat.send("整えて");
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
