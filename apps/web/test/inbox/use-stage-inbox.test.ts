import type { ViewerId } from "@hell-ict/content";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref, shallowRef } from "vue";

import { useMailRead } from "../../src/inbox/use-mail-read.js";
import { useMailSelection, useStageInbox } from "../../src/inbox/use-stage-inbox.js";
import type { InboxRow, StageInstance } from "../../src/stages/stage-module.js";
import { FakeKeyValueStorage } from "../fakes.js";

const rows: readonly InboxRow[] = [
  { id: "c", from: "事務長", subject: "本文を読む", opens: { kind: "center" } },
  { id: "v", from: "河合", subject: "添付", opens: { kind: "viewer", doc: "s3contaminated" } },
  { id: "s", from: "院長", subject: "ステージ固有", opens: { kind: "stage" } },
  { id: "x", from: "終", subject: "時間切れ", opens: { kind: "center" }, closed: true },
];

const setup = (withInbox = true) => {
  const opened: string[] = [];
  const viewed: ViewerId[] = [];
  const stageRows = ref<readonly InboxRow[]>(rows);
  const instance = shallowRef<StageInstance | null>({
    center: { render: () => null },
    ...(withInbox ? { inbox: { rows: stageRows, onOpen: (id: string) => opened.push(id) } } : {}),
  });
  const storage = new FakeKeyValueStorage();
  const mail = useMailSelection();
  const pane = effectScope().run(() =>
    useStageInbox({
      instance,
      mail,
      mailRead: useMailRead(storage, ref("123456")),
      openViewer: (doc) => viewed.push(doc),
    }),
  );
  if (pane === undefined) throw new Error("the scope did not run");
  return { pane, mail, instance, opened, viewed, stageRows, storage };
};

describe("useStageInbox", () => {
  it("受信トレイの無いステージ（準備中を含む）は何も出さない", () => {
    expect(setup(false).pane.view.value).toBeNull();
  });

  it("中央で開く行: 既読にして、中央が読む id に入れる", () => {
    const { pane, mail, viewed, opened } = setup();
    pane.select("c");
    expect(mail.openId.value).toBe("c");
    expect(pane.view.value?.items[0]?.current).toBe(true);
    expect(pane.view.value?.items[0]?.read).toBe(true);
    expect([viewed, opened]).toEqual([[], []]);
  });

  it("viewer で開く行: ビューアに文書を開かせ、中央は変えない", () => {
    const { pane, mail, viewed } = setup();
    pane.select("v");
    expect(viewed).toEqual(["s3contaminated"]);
    expect(mail.openId.value).toBeNull();
    // c と s が未読のまま（x は締め切り済みで数えない）。
    expect(pane.view.value?.unread).toBe(2);
  });

  it("ステージ固有の行: ステージの onOpen を呼ぶ", () => {
    const { pane, opened } = setup();
    pane.select("s");
    expect(opened).toEqual(["s"]);
  });

  it("締め切られた行・無い行を押しても何も起きない（既読にもしない）", () => {
    const { pane, mail, viewed, opened, storage } = setup();
    pane.select("x");
    pane.select("nope");
    expect([mail.openId.value, viewed, opened]).toEqual([null, [], []]);
    expect(storage.values.size).toBe(0);
  });

  it("行が 250ms ごとに作り直されても、既読と中央の選択は残る", () => {
    const { pane, stageRows } = setup();
    pane.select("c");
    stageRows.value = rows.map((row) => ({ ...row }));
    expect(pane.view.value?.items[0]).toMatchObject({ read: true, current: true });
  });

  it("ステージが替わったら中央の選択を閉じる", async () => {
    const { pane, mail, instance } = setup();
    pane.select("c");
    instance.value = { center: { render: () => null } };
    await nextTick();
    expect(mail.openId.value).toBeNull();
    expect(pane.view.value).toBeNull();
  });
});
