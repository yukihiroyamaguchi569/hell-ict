import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { PreloadAsset } from "../../src/opening/preload-manifest.js";
import {
  BACKDROP_HEAD_START_MS,
  OPENING_LIMIT_MS,
  useOpeningPreload,
} from "../../src/opening/use-opening-preload.js";
import type { PreloadResult } from "../../src/ports.js";
import { FakeScheduler, flush } from "../fakes.js";

/**
 * Preloads that settle only when the test answers them, by src or `sound:<name>`. Like the real
 * preloader, a key loaded or on its way is not asked for again; one that failed is.
 */
class FakeAssetLoader {
  readonly asked: string[] = [];
  private readonly answers = new Map<string, (result: PreloadResult) => void>();
  private readonly known = new Map<string, Promise<PreloadResult>>();

  readonly images = { preload: (src: string) => this.wait(src) };
  readonly audio = { preload: (name: string) => this.wait(`sound:${name}`) };

  answer(key: string, result: PreloadResult): void {
    this.answers.get(key)?.(result);
  }

  private wait(key: string): Promise<PreloadResult> {
    const known = this.known.get(key);
    if (known !== undefined) return known;
    this.asked.push(key);
    const promise = new Promise<PreloadResult>((resolve) => {
      this.answers.set(key, resolve);
    }).then((result) => {
      if (result === "failed") this.known.delete(key);
      return result;
    });
    this.known.set(key, promise);
    return promise;
  }
}

const BACKDROP = "/a.webp";

const ASSETS: readonly PreloadAsset[] = [
  { kind: "image", src: BACKDROP },
  { kind: "image", src: "/b.png" },
  { kind: "sound", name: "don-1" },
  { kind: "sound", name: "cancel" },
  { kind: "image", src: "/c.svg" },
];

const REST = ["/b.png", "sound:don-1", "sound:cancel", "/c.svg"];

const setup = (assets: readonly PreloadAsset[] = ASSETS) => {
  const loader = new FakeAssetLoader();
  const scheduler = new FakeScheduler();
  const scope = effectScope();
  const preload = scope.run(() =>
    useOpeningPreload({
      backdrop: BACKDROP,
      assets,
      images: loader.images,
      audio: loader.audio,
      scheduler,
    }),
  );
  if (preload === undefined) throw new Error("the scope did not run");
  return { loader, scheduler, scope, preload };
};

/** The backdrop loads, and the rest starts. */
const loadBackdrop = async (loader: FakeAssetLoader): Promise<void> => {
  loader.answer(BACKDROP, "loaded");
  await flush();
};

describe("useOpeningPreload", () => {
  it("最初は背景の画像だけを取りに行く（遅い回線でも病院の絵を先に出す）", () => {
    const { loader, preload } = setup();
    expect(loader.asked).toEqual([BACKDROP]);
    expect(preload.total).toBe(5);
    expect(preload.settled.value).toBe(0);
    expect(preload.finished.value).toBe(false);
  });

  it("背景が読めたら、残りを一度に取りに行く（画像は src、効果音は名前で。背景は取り直さない）", async () => {
    const { loader, scheduler, preload } = setup();
    await loadBackdrop(loader);
    expect(loader.asked).toEqual([BACKDROP, ...REST]);
    expect(preload.settled.value).toBe(1);
    // 背景が先に終わったので、5秒の猶予のタイマーは取り消し、15秒の上限だけが残る。
    expect(scheduler.pending).toBe(1);
    scheduler.advanceBy(BACKDROP_HEAD_START_MS);
    expect(loader.asked).toEqual([BACKDROP, ...REST]);
  });

  it("背景の読み込みに失敗しても残りへ進む（背景は一覧の側でもう一度だけ頼む）", async () => {
    const { loader, preload } = setup();
    loader.answer(BACKDROP, "failed");
    await flush();
    expect(loader.asked).toEqual([BACKDROP, BACKDROP, ...REST]);
    expect(preload.settled.value).toBe(0);
    loader.answer(BACKDROP, "failed");
    await flush();
    expect(preload.settled.value).toBe(1);
    expect(preload.failed.value).toBe(1);
  });

  it("終わった数を数える。全部終わったら finished になり、上限のタイマーを取り消す", async () => {
    const { loader, scheduler, preload } = setup();
    expect(scheduler.delays).toEqual([OPENING_LIMIT_MS, BACKDROP_HEAD_START_MS]);
    await loadBackdrop(loader);
    loader.answer("sound:don-1", "loaded");
    await flush();
    expect(preload.settled.value).toBe(2);
    expect(preload.finished.value).toBe(false);
    for (const key of ["/b.png", "sound:cancel", "/c.svg"]) loader.answer(key, "loaded");
    await flush();
    expect(preload.settled.value).toBe(5);
    expect(preload.finished.value).toBe(true);
    expect(scheduler.pending).toBe(0);
  });

  it("失敗も終わった1件として数え、進行を止めない（失敗の数は別に記録する）", async () => {
    const { loader, preload } = setup();
    await loadBackdrop(loader);
    loader.answer("/b.png", "failed");
    loader.answer("sound:cancel", "failed");
    for (const key of ["sound:don-1", "/c.svg"]) loader.answer(key, "loaded");
    await flush();
    expect(preload.settled.value).toBe(5);
    expect(preload.failed.value).toBe(2);
    expect(preload.finished.value).toBe(true);
  });

  it("すべて失敗しても finished になる", async () => {
    const { loader, preload } = setup();
    loader.answer(BACKDROP, "failed");
    await flush();
    for (const key of [BACKDROP, ...REST]) loader.answer(key, "failed");
    await flush();
    expect(preload.failed.value).toBe(5);
    expect(preload.finished.value).toBe(true);
  });

  it("15秒の直前までは待ち、15秒で終わっていなくても finished になる", () => {
    const { scheduler, preload } = setup();
    scheduler.advanceBy(OPENING_LIMIT_MS - 1);
    expect(preload.finished.value).toBe(false);
    scheduler.advanceBy(1);
    expect(preload.finished.value).toBe(true);
    expect(OPENING_LIMIT_MS).toBe(15_000);
  });

  it("15秒は背景の読み込みも含めて数える（背景が読めないまま15秒でも進む）", () => {
    const { scheduler, preload } = setup();
    scheduler.advanceBy(OPENING_LIMIT_MS - 1);
    expect(preload.finished.value).toBe(false);
    scheduler.advanceBy(1);
    expect(preload.finished.value).toBe(true);
  });

  it("背景が応答しないまま5秒たったら、そこで残りを読み始める（15秒より前に）", async () => {
    const { loader, scheduler, preload } = setup();
    expect(BACKDROP_HEAD_START_MS).toBeLessThan(OPENING_LIMIT_MS);
    scheduler.advanceBy(BACKDROP_HEAD_START_MS - 1);
    expect(loader.asked).toEqual([BACKDROP]);
    scheduler.advanceBy(1);
    expect(loader.asked).toEqual([BACKDROP, ...REST]);
    expect(preload.finished.value).toBe(false);
    for (const key of REST) loader.answer(key, "loaded");
    await flush();
    expect(preload.settled.value).toBe(4);
    // 遅れて背景が届いても、残りを2度は頼まない。背景も1件として数える。
    loader.answer(BACKDROP, "loaded");
    await flush();
    expect(loader.asked).toEqual([BACKDROP, ...REST]);
    expect(preload.settled.value).toBe(5);
  });

  it("15秒で先へ進んだ後も、残りは裏で読み続けて数える", async () => {
    const { loader, scheduler, preload } = setup();
    await loadBackdrop(loader);
    scheduler.advanceBy(OPENING_LIMIT_MS);
    expect(preload.finished.value).toBe(true);
    expect(preload.settled.value).toBe(1);
    loader.answer("/b.png", "loaded");
    await flush();
    expect(preload.settled.value).toBe(2);
    expect(preload.finished.value).toBe(true);
  });

  it("対象が無ければ最初から finished で、タイマーも掛けない", () => {
    const { scheduler, preload } = setup([]);
    expect(preload.finished.value).toBe(true);
    expect(scheduler.delays).toEqual([]);
  });

  it("画面を閉じた（scope を破棄した）ら上限のタイマーを取り消す", () => {
    const { scheduler, scope } = setup();
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
