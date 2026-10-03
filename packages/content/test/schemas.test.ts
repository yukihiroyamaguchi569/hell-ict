import { describe, expect, it } from "vitest";

import {
  linesSchema,
  mailSchema,
  fieldEchoSchema,
  fullscreenArtSchema,
  portraitSchema,
  stage1MailSchema,
  viewerDocSchema,
  viewerTableSchema,
} from "../src/schemas.js";

const validMail = { from: "人事課", subj: "件名", body: ["本文"] };

describe("linesSchema", () => {
  it("1行以上の空でない文字列を受け付ける", () => {
    expect(linesSchema.parse(["a"])).toEqual(["a"]);
  });

  it.each([
    ["空配列", []],
    ["空文字の行", ["a", ""]],
    ["文字列でない行", ["a", 1]],
  ])("%sを拒否する", (_label, value) => {
    expect(linesSchema.safeParse(value).success).toBe(false);
  });
});

describe("mailSchema", () => {
  it("添付の有無どちらも受け付ける", () => {
    expect(mailSchema.parse(validMail)).toEqual(validMail);
    expect(mailSchema.parse({ ...validMail, attach: "a.pdf" })).toEqual({
      ...validMail,
      attach: "a.pdf",
    });
  });

  it.each([
    ["差出人が空", { ...validMail, from: "" }],
    ["件名が無い", { from: "人事課", body: ["本文"] }],
    ["本文が空", { ...validMail, body: [] }],
    ["添付名が空", { ...validMail, attach: "" }],
    ["未知のキー", { ...validMail, at: 0 }],
  ])("%sを拒否する", (_label, value) => {
    expect(mailSchema.safeParse(value).success).toBe(false);
  });
});

describe("stage1MailSchema", () => {
  const valid = { ...validMail, id: "m1" };

  it("id と任意の困惑・下書きを受け付ける", () => {
    expect(stage1MailSchema.parse(valid)).toEqual(valid);
    const full = { ...valid, sad: "……", draftPlain: ["a"], draftCtx: ["b"] };
    expect(stage1MailSchema.parse(full)).toEqual(full);
  });

  it.each([
    ["id が無い", validMail],
    ["id が空", { ...valid, id: "" }],
    ["下書きが空配列", { ...valid, draftCtx: [] }],
    // 着弾時刻は時間処理の値なので content に持たせない。
    ["着弾時刻 at を持つ", { ...valid, at: 0 }],
  ])("%sを拒否する", (_label, value) => {
    expect(stage1MailSchema.safeParse(value).success).toBe(false);
  });
});

describe("viewerTableSchema", () => {
  it("見出しと同じ列数の行を受け付ける（空セル・0行も可）", () => {
    const table = { header: ["a", "b"], rows: [["1", ""]] };
    expect(viewerTableSchema.parse(table)).toEqual(table);
    expect(viewerTableSchema.parse({ header: ["a"], rows: [] })).toEqual({
      header: ["a"],
      rows: [],
    });
  });

  it.each([
    ["列が足りない行", { header: ["a", "b"], rows: [["1"]] }],
    ["列が多すぎる行", { header: ["a"], rows: [["1", "2"]] }],
    ["見出しが空", { header: [], rows: [] }],
  ])("%sを拒否する", (_label, value) => {
    expect(viewerTableSchema.safeParse(value).success).toBe(false);
  });

  it("列数の食い違いは、どこが悪いかを言う文言で拒否する", () => {
    const result = viewerTableSchema.safeParse({ header: ["a", "b"], rows: [["1"]] });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "表の各行は見出しと同じ列数を持つ必要があります。",
    ]);
  });
});

describe("viewerDocSchema", () => {
  it("見出しと本文、任意の折り返し・表を受け付ける", () => {
    const doc = { name: "a.txt", text: "本文", wrap: true };
    expect(viewerDocSchema.parse(doc)).toEqual(doc);
  });

  it.each([
    ["本文が空", { name: "a.txt", text: "" }],
    ["見出しが無い", { text: "本文" }],
    ["表の列数が合わない", { name: "a", text: "t", table: { header: ["a"], rows: [["1", "2"]] } }],
  ])("%sを拒否する", (_label, value) => {
    expect(viewerDocSchema.safeParse(value).success).toBe(false);
  });
});

describe("portraitSchema", () => {
  const portrait = { img: "a.png", org: "", role: "院長" };

  it("所属は空文字を許す（肩書の行だけを出す話者）", () => {
    expect(portraitSchema.parse(portrait)).toEqual(portrait);
  });

  it.each([
    ["画像が空", { ...portrait, img: "" }],
    ["役職が空", { ...portrait, role: "" }],
  ])("%sを拒否する", (_label, value) => {
    expect(portraitSchema.safeParse(value).success).toBe(false);
  });
});

describe("fullscreenArtSchema", () => {
  it("位置は省略でき、書くなら「横% 縦%」", () => {
    expect(fullscreenArtSchema.parse({ img: "a.webp" })).toEqual({ img: "a.webp" });
    expect(fullscreenArtSchema.parse({ img: "a.webp", position: "50% 0%" })).toEqual({
      img: "a.webp",
      position: "50% 0%",
    });
    expect(fullscreenArtSchema.parse({ img: "a.webp", position: "100% 100%" }).position).toBe(
      "100% 100%",
    );
  });

  it.each([
    ["画像が空", { img: "" }],
    ["位置がキーワード", { img: "a.webp", position: "center top" }],
    ["位置が1軸だけ", { img: "a.webp", position: "50%" }],
    ["位置が px", { img: "a.webp", position: "10px 20px" }],
    ["位置に余計な文字", { img: "a.webp", position: "50% 20%; color: red" }],
    ["知らない鍵", { img: "a.webp", fit: "contain" }],
  ])("%sを拒否する", (_label, value) => {
    expect(fullscreenArtSchema.safeParse(value).success).toBe(false);
  });
});

describe("fieldEchoSchema", () => {
  const echo = { org: "", role: "夜勤師長", fullscreen: { img: "a.webp" }, lines: ["x"] };

  it("所属は空文字を許す", () => {
    expect(fieldEchoSchema.parse(echo)).toEqual(echo);
  });

  it.each([
    ["台詞が無い", { ...echo, lines: [] }],
    ["全画面の絵が無い", { org: "", role: "夜勤師長", lines: ["x"] }],
    ["小さな肖像の img を持つ", { ...echo, img: "a.png" }],
    ["役職が空", { ...echo, role: "" }],
  ])("%sを拒否する", (_label, value) => {
    expect(fieldEchoSchema.safeParse(value).success).toBe(false);
  });
});
