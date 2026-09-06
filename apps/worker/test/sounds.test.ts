import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleSoundRequest, SOUND_NAMES, soundKeyFromPath } from "../src/sounds.js";
import type { SoundObject, SoundsBucket } from "../src/sounds.js";

import { TEST_ORIGIN } from "./support.js";

/**
 * 効果音は同一オリジンの`<audio>`（モックの`sfx()`）が取りに来る。ブラウザは
 * この経路にOriginも`Sec-Fetch-Site: same-origin`も付けるとは限らないので、
 * テストのリクエストもヘッダーを一切足さない素のGETにする——ここに入口ガードが
 * 掛かっていないことを、テストの形そのもので保つ。
 */
const getSound = async (path: string): Promise<Response> =>
  exports.default.fetch(new Request(`${TEST_ORIGIN}${path}`));

/**
 * 本文をバイト列から読む。`response.text()`はContent-Typeがaudio/mpegだと
 * 「テキストではない」と警告を出すため、デコードは自分で行う。
 */
const bodyText = async (response: Response): Promise<string> =>
  new TextDecoder().decode(await response.arrayBuffer());

/**
 * `get`の呼び出し回数を数えるFake。`SoundsBucket`は配信に使う`body`と`httpEtag`
 * だけに絞った形なので、キャストなしでそのまま満たせる。
 */
const fakeBucket = (
  objects: ReadonlyMap<string, string>,
): { bucket: SoundsBucket; calls: string[] } => {
  const calls: string[] = [];
  const bucket: SoundsBucket = {
    get: (key: string): Promise<SoundObject | null> => {
      calls.push(key);
      const content = objects.get(key);
      if (content === undefined) return Promise.resolve(null);
      return Promise.resolve({ httpEtag: '"fake-etag"', body: new Blob([content]).stream() });
    },
  };
  return { bucket, calls };
};

describe("効果音の配信（R2）", () => {
  describe("soundKeyFromPath", () => {
    it("許可リストの7点だけをキーとして通す", () => {
      for (const name of SOUND_NAMES) {
        expect(soundKeyFromPath(`/sounds/${name}.mp3`)).toBe(`${name}.mp3`);
      }
    });

    it("形は正しくても許可リストに無い名前は通さない", () => {
      expect(soundKeyFromPath("/sounds/unknown.mp3")).toBeNull();
    });

    it("拡張子違い・大文字・二重スラッシュ・パーセント符号化を通さない", () => {
      expect(soundKeyFromPath("/sounds/decision1.mp4")).toBeNull();
      expect(soundKeyFromPath("/sounds/Decision1.mp3")).toBeNull();
      expect(soundKeyFromPath("/sounds//decision1.mp3")).toBeNull();
      expect(soundKeyFromPath("/sounds/%2e%2e/decision1.mp3")).toBeNull();
      expect(soundKeyFromPath("/sounds/sub/decision1.mp3")).toBeNull();
      expect(soundKeyFromPath("/sounds/")).toBeNull();
      expect(soundKeyFromPath("/soundsdecision1.mp3")).toBeNull();
    });
  });

  describe("handleSoundRequest", () => {
    it("R2にあるキーは200・audio/mpeg・キャッシュ指定・ETagで返す", async () => {
      const { bucket, calls } = fakeBucket(new Map([["decision1.mp3", "ID3"]]));

      const response = await handleSoundRequest(bucket, "/sounds/decision1.mp3");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
      expect(response.headers.get("ETag")).toBe('"fake-etag"');
      await expect(bodyText(response)).resolves.toBe("ID3");
      expect(calls).toEqual(["decision1.mp3"]);
    });

    it("許可リストにあってもR2に無ければ404", async () => {
      const { bucket, calls } = fakeBucket(new Map());

      const response = await handleSoundRequest(bucket, "/sounds/decision1.mp3");

      expect(response.status).toBe(404);
      // 名前は通っているので、無いことの確認でR2は1回だけ引く。
      expect(calls).toEqual(["decision1.mp3"]);
    });

    it("不正なファイル名はR2を1度も呼ばずに404", async () => {
      const { bucket, calls } = fakeBucket(new Map([["decision1.mp3", "ID3"]]));

      for (const path of [
        "/sounds/../x.mp3",
        "/sounds/%2e%2e/decision1.mp3",
        "/sounds/decision1.mp4",
        "/sounds//decision1.mp3",
        "/sounds/Decision1.mp3",
        "/sounds/unknown.mp3",
        "/sounds/",
      ]) {
        const response = await handleSoundRequest(bucket, path);
        expect(response.status).toBe(404);
      }

      expect(calls).toEqual([]);
    });
  });

  describe("GET /sounds/* （Worker経由）", () => {
    it("R2へ入れたmp3を200・audio/mpegで配る", async () => {
      await env.SOUNDS.put("success1.mp3", "ID3-success");

      const response = await getSound("/sounds/success1.mp3");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
      expect(response.headers.get("ETag")).not.toBeNull();
      await expect(bodyText(response)).resolves.toBe("ID3-success");
    });

    it("R2に無いキーは404", async () => {
      const response = await getSound("/sounds/cancel.mp3");

      expect(response.status).toBe(404);
    });

    it("`..`はURL正規化で/sounds/の外へ出るので404", async () => {
      await env.SOUNDS.put("don-1.mp3", "ID3-don");

      // `/sounds/../don-1.mp3` は new URL() が `/don-1.mp3` へ畳むため、
      // /sounds/ 配下として扱われない。R2にキーが在っても配らない。
      const response = await getSound("/sounds/../don-1.mp3");

      expect(response.status).toBe(404);
    });

    it("パーセント符号化・大文字・二重スラッシュは404", async () => {
      await env.SOUNDS.put("cancel.mp3", "ID3-cancel");

      for (const path of [
        "/sounds/%2e%2e/cancel.mp3",
        "/sounds/Cancel.mp3",
        "/sounds//cancel.mp3",
        "/sounds/cancel.mp4",
      ]) {
        const response = await getSound(path);
        expect(response.status, path).toBe(404);
      }
    });
  });
});
