import { z } from "zod";

/**
 * 画面のid。モックのSTEPS（docs/ui/mock/index.html）と1対1で対応する。
 *
 * 自由文字列にしておくと、表示用の列がPIIの抜け道になる——`/^[a-z0-9-]+$/`は
 * `090-1234-5678`のような電話番号を通してしまい、text・metaのPIIゲートを素通りして
 * D1へ残る。画面idは有限の集合なので、enumで固定するのがいちばん確実に塞げる。
 *
 * 画面を追加したらここへ足す。追加を忘れると保存が400で落ちるので、黙って
 * 通り抜けることはない。
 */
export const VIEW_IDS = [
  "entry",
  "welcome",
  "inbox",
  "s1",
  "s2",
  "unlock",
  "s3",
  "s35",
  "s4",
  "s5",
  "final",
] as const;

export const viewIdSchema = z.enum(VIEW_IDS);

export type ViewId = z.infer<typeof viewIdSchema>;
