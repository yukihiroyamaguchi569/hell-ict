/*
 * 入室前の読み込み画面（Issue #379）。会場の回線が弱くても、使う瞬間に画像や効果音を
 * 初めて取りに行かずに済むよう、ゲームで使うアセットを入室画面の前にまとめて先読みする。
 */

/** 読み込み画面の背景（病院の外観）と、進み具合の文言（「読み込み中 60%」の「読み込み中」）。 */
export const opening = {
  img: "opening-saint-chronos-hospital-exterior.webp",
  alt: "聖クロノス総合病院の外観",
  loading: "読み込み中",
} as const;

/**
 * assets/images/production/ に置いた画像のすべて（Worker が /assets/images/production/ で配る）。
 * 読み込み画面がまとめて先読みする。実ファイルとの食い違いはテストが突き合わせて止める。
 */
export const productionImages = [
  "final-certificate-frame.webp",
  "final-goal-ceremony.webp",
  "opening-saint-chronos-hospital-exterior.webp",
  "stage1-administrative-director-clear.webp",
  "stage1-administrative-director.png",
  "stage1-ward-3b-nurse-clear.webp",
  "stage2-nursing-director-clear.webp",
  "stage2-ward-5a-head-nurse-clear.webp",
  "stage3-dermatologist.png",
  "stage3-nursing-director-clear.webp",
  "stage3-nursing-director.png",
  "stage3-penalty-bottle.svg",
  "stage3-penalty-sanitizer-irasutoya.png",
  "stage3-ward-3b-head-nurse-clear.webp",
  "stage35-director.png",
  "stage4-hospital-director-clear.webp",
  "stage4-night-shift-head-nurse-clear.webp",
  "stage5-administrative-director-clear.webp",
  "stage5-poster-default.png",
  "stage5-poster-multilingual.png",
  "stage5-poster-pictogram.png",
  "stage5-poster-textheavy.png",
  "stage5-ward-5b-head-nurse-clear.webp",
  "stage6-administrative-director-clear.webp",
  "stage6-patient-relations-kondo-clear.webp",
] as const;
