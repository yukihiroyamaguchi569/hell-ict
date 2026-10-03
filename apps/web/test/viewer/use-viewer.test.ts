import { stage5FeverTable, viewerDocs } from "@hell-ict/content";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { ClipboardPort } from "../../src/ports.js";
import { useViewer } from "../../src/viewer/use-viewer.js";
import { COPIED_MS, NO_COLUMNS_MS, selectedColumnsText } from "../../src/viewer/viewer-view.js";
import { FakeScheduler, flush } from "../fakes.js";

interface HeldWrite {
  resolve(): void;
  reject(error: Error): void;
}

/** `holding` keeps each write open until the test settles it from `held`, in any order. */
class FakeClipboard implements ClipboardPort {
  readonly written: string[] = [];
  readonly held: HeldWrite[] = [];
  failing = false;
  holding = false;

  writeText(text: string): Promise<void> {
    this.written.push(text);
    if (this.holding) {
      return new Promise<void>((resolve, reject) => {
        this.held.push({ resolve, reject });
      });
    }
    return this.failing ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
  }
}

const setup = () => {
  const scheduler = new FakeScheduler();
  const clipboard = new FakeClipboard();
  const scope = effectScope();
  const viewer = scope.run(() => useViewer({ clipboard, scheduler }));
  if (viewer === undefined) throw new Error("scope did not run");
  return { scheduler, clipboard, viewer, scope };
};

describe("useViewer", () => {
  it("開く前は何も出さず、コピーも書かない", () => {
    const { viewer, clipboard } = setup();
    expect(viewer.openId.value).toBeNull();
    expect(viewer.sheet.value).toBeNull();
    viewer.copyAll();
    viewer.copyColumns();
    expect(clipboard.written).toEqual([]);
  });

  it("開いて閉じる", () => {
    const { viewer } = setup();
    viewer.open("s3manual");
    expect(viewer.openId.value).toBe("s3manual");
    expect(viewer.sheet.value?.name).toBe(viewerDocs.s3manual.name);
    expect(viewer.picked.value).toEqual([]);
    viewer.close();
    expect(viewer.openId.value).toBeNull();
    expect(viewer.sheet.value).toBeNull();
  });

  it("［コピー］は全文を書き、書けたら 1400ms だけ「コピーしました」", async () => {
    const { viewer, clipboard, scheduler } = setup();
    viewer.open("s3manual");
    viewer.copyAll();
    await flush();
    expect(clipboard.written).toEqual([viewerDocs.s3manual.text]);
    expect(viewer.copyLabel.value).toBe("コピーしました");
    scheduler.advanceBy(COPIED_MS - 1);
    expect(viewer.copyLabel.value).toBe("コピーしました");
    scheduler.advanceBy(1);
    expect(viewer.copyLabel.value).toBe("コピー");
  });

  it("続けて押すと、戻すのは最後の押下から 1400ms 後", async () => {
    const { viewer, scheduler } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    await flush();
    scheduler.advanceBy(1_000);
    viewer.copyAll();
    await flush();
    scheduler.advanceBy(1_000);
    expect(viewer.copyLabel.value).toBe("コピーしました");
    expect(scheduler.pending).toBe(1);
    scheduler.advanceBy(400);
    expect(viewer.copyLabel.value).toBe("コピー");
  });

  it("クリップボードが拒んだら「コピーできませんでした」を 1400ms 出す（成功とは言わない）", async () => {
    const { viewer, clipboard, scheduler } = setup();
    clipboard.failing = true;
    viewer.open("s1memo");
    viewer.copyAll();
    expect(viewer.copyLabel.value).not.toBe("コピーしました");
    await flush();
    expect(clipboard.written).toHaveLength(1);
    expect(viewer.copyLabel.value).toBe("コピーできませんでした");
    scheduler.advanceBy(COPIED_MS - 1);
    expect(viewer.copyLabel.value).toBe("コピーできませんでした");
    scheduler.advanceBy(1);
    expect(viewer.copyLabel.value).toBe("コピー");
  });

  it("列選択コピーも、拒まれたら「コピーできませんでした」", async () => {
    const { viewer, clipboard, scheduler } = setup();
    clipboard.failing = true;
    viewer.open("s5list");
    viewer.copyColumns();
    expect(viewer.columnsLabel.value).not.toBe("コピーしました");
    await flush();
    expect(viewer.columnsLabel.value).toBe("コピーできませんでした");
    scheduler.advanceBy(COPIED_MS);
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
  });

  it("書き込みが終わる前は「コピーしました」を出さない", () => {
    const { viewer } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    expect(viewer.copyLabel.value).toBe("コピー");
  });

  it("書き込みの完了が閉じた後や別の文書を開いた後に届いたら、表示を変えない", async () => {
    const { viewer, scheduler } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    viewer.open("s3manual");
    await flush();
    expect(viewer.copyLabel.value).toBe("コピー");
    expect(scheduler.pending).toBe(0);
  });

  it("s6notice（去年の掲示物）はコピーできない", () => {
    const { viewer, clipboard } = setup();
    viewer.open("s6notice");
    expect(viewer.sheet.value?.copyable).toBe(false);
    viewer.copyAll();
    expect(clipboard.written).toEqual([]);
    expect(viewer.copyLabel.value).toBe("コピー");
  });

  it("列選択：開くたびに全列ON、外した列を除いた TSV を書く", async () => {
    const { viewer, clipboard, scheduler } = setup();
    viewer.open("s5list");
    expect(viewer.picked.value).toEqual(stage5FeverTable.header.map(() => true));
    viewer.toggleColumn(1);
    viewer.copyColumns();
    const expected = selectedColumnsText(
      stage5FeverTable,
      stage5FeverTable.header.map((_, i) => i !== 1),
    );
    expect(clipboard.written).toEqual([expected]);
    await flush();
    expect(viewer.columnsLabel.value).toBe("コピーしました");
    scheduler.advanceBy(COPIED_MS);
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");

    viewer.close();
    viewer.open("s5list");
    expect(viewer.picked.value.every((on) => on)).toBe(true);
  });

  it("0列なら何も書かず、1600ms だけ警告", () => {
    const { viewer, clipboard, scheduler } = setup();
    viewer.open("s5list");
    stage5FeverTable.header.forEach((_, i) => {
      viewer.toggleColumn(i);
    });
    viewer.copyColumns();
    expect(clipboard.written).toEqual([]);
    expect(viewer.columnsLabel.value).toBe("列を1つ以上選んでください");
    scheduler.advanceBy(NO_COLUMNS_MS - 1);
    expect(viewer.columnsLabel.value).toBe("列を1つ以上選んでください");
    scheduler.advanceBy(1);
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
  });

  it("表の無い文書では列選択コピーは何もしない", () => {
    const { viewer, clipboard } = setup();
    viewer.open("s3manual");
    viewer.copyColumns();
    expect(clipboard.written).toEqual([]);
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
  });

  it("別の文書を開くとボタンの表示とタイマーを戻す", async () => {
    const { viewer, scheduler } = setup();
    viewer.open("s5list");
    viewer.copyAll();
    viewer.copyColumns();
    await flush();
    expect(scheduler.pending).toBe(2);
    viewer.open("s1memo");
    expect(viewer.copyLabel.value).toBe("コピー");
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
    expect(scheduler.pending).toBe(0);
  });

  it("スコープを捨てるとタイマーも捨てる", async () => {
    const { viewer, scheduler, scope } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    await flush();
    expect(scheduler.pending).toBe(1);
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });

  it("スコープを捨てた後に書き込みが終わっても、タイマーを仕掛けない", async () => {
    const { viewer, scheduler, scope } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    scope.stop();
    await flush();
    expect(scheduler.pending).toBe(0);
  });

  it("同じボタンを続けて押したら、表示を決めるのは最後の押下の結果（先の結果が後から届いても上書きしない）", async () => {
    const { viewer, clipboard, scheduler } = setup();
    clipboard.holding = true;
    viewer.open("s1memo");
    viewer.copyAll();
    viewer.copyAll();
    clipboard.held[1]?.resolve();
    await flush();
    expect(viewer.copyLabel.value).toBe("コピーしました");
    clipboard.held[0]?.reject(new Error("NotAllowedError"));
    await flush();
    expect(viewer.copyLabel.value).toBe("コピーしました");
    expect(scheduler.pending).toBe(1);
  });

  it("コピーの結果待ちの間に出した0列の警告は、保留分が後から届いても消されない", async () => {
    const { viewer, clipboard, scheduler } = setup();
    clipboard.holding = true;
    viewer.open("s5list");
    viewer.copyColumns();
    stage5FeverTable.header.forEach((_, i) => {
      viewer.toggleColumn(i);
    });
    viewer.copyColumns();
    expect(viewer.columnsLabel.value).toBe("列を1つ以上選んでください");
    clipboard.held[0]?.resolve();
    await flush();
    expect(viewer.columnsLabel.value).toBe("列を1つ以上選んでください");
    scheduler.advanceBy(NO_COLUMNS_MS);
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
  });

  it("結果待ちの間に閉じたら、後から届いても表示もタイマーも変えない", async () => {
    const { viewer, clipboard, scheduler } = setup();
    clipboard.holding = true;
    viewer.open("s5list");
    viewer.copyAll();
    viewer.copyColumns();
    viewer.close();
    clipboard.held[0]?.resolve();
    clipboard.held[1]?.reject(new Error("NotAllowedError"));
    await flush();
    expect(viewer.copyLabel.value).toBe("コピー");
    expect(viewer.columnsLabel.value).toBe("選んだ列をコピー");
    expect(scheduler.pending).toBe(0);
  });

  it("閉じると、出ていた表示とタイマーも戻す", async () => {
    const { viewer, scheduler } = setup();
    viewer.open("s1memo");
    viewer.copyAll();
    await flush();
    expect(scheduler.pending).toBe(1);
    viewer.close();
    expect(viewer.copyLabel.value).toBe("コピー");
    expect(scheduler.pending).toBe(0);
  });
});
