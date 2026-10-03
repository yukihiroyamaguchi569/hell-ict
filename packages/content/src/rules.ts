import type { Stage3Rules, Stage4Rules, Stage6Rules } from "./schemas.js";

/*
 * 判定の語（ダミーシナリオの答え）。判定の順序・差し戻しの理由・ヒントは domain が持ち、
 * ここは語だけを持つ。語は書かれたとおりに当てる（正規化はしない）。
 */

/** Stage 3（架空の皮膚感染症「斑紋症」）。正解は「足さない」側で、罠は過剰対応。 */
export const stage3Rules = {
  required: {
    // Stay in the shared room; gloves only for care.
    ppe: [/大部屋/, /手袋/],
    // Release needs both "application completed" and "72 hours", within one sentence.
    release: [/塗布[^。]{0,20}(完了|終了)/, /72時間/],
    // Sheets go to normal laundry and bleach is not needed: both must be written.
    clean: [/通常/, /漂白剤/, /不要/],
  },
  traps: {
    // Single room / gown without 不要 or 大部屋.
    ppe: { words: /個室|ガウン/, unless: /不要|大部屋/ },
    // "Keep it for a while (a month)" without the manual's 72 hours.
    release: { words: /継続|当面|1か月/, unless: /72時間/ },
    // Bleach / disposal / boiling without 不要.
    clean: { words: /漂白剤|廃棄|煮沸/, unless: /不要/ },
  },
  fabricatedSource: /南北療養施設協議会|斑紋症対応ガイド/,
} as const satisfies Stage3Rules;

/** Stage 4（新しい報告を読む）。発熱に先立つ耳の症状と、まだ発熱していない人への聞き取り。 */
export const stage4Rules = {
  /** Ringing in the ears or sensitivity to sound, in medical terms or plain words. */
  summary: /耳鳴|聴覚過敏|音[^。、\n]{0,5}(過敏|敏感)|耳が?[^。、\n]{0,3}(鳴|響)/,
  /** Whom to ask: people who are not febrile yet (visiting families etc.). */
  actionTarget: /家族|面会者|付き添い|見舞/,
  /** What to ask. Looser than the summary (a bare 耳, 問診, 聞) because it is paired with a target. */
  actionContent: /耳鳴|耳|音[^。、\n]{0,5}(過敏|敏感)|問診|聞/,
  /**
   * An action aimed at patients, who are already febrile. It also matches words that name no one
   * (入院, 在院), so domain uses it only to tell `aimed-at-patients` apart, never as "whom".
   */
  actionPatient: /患者|入院|在院|発熱者/,
} as const satisfies Stage4Rules;

/** Stage 6（面会制限の掲示）。 */
export const stage6Rules = {
  posterTags: [
    { type: "pictogram", tag: /ピクトグラム|イラスト|図解|絵/ },
    { type: "multilingual", tag: /多言語|英語|中国語|やさしい日本語/ },
    { type: "textheavy", tag: /文章|文字|お知らせ文|前回/ },
  ],
  /**
   * Visiting hours accept natural phrasings ("14時から16時まで", "15分以内の面会") but not
   * "制限" alone, so the title "面会制限のお知らせ" does not pass by itself.
   */
  requirements: {
    mask: /マスク/,
    visitingHours: /面会.{0,20}(時間|\d{1,2}\s*時|分以内)|(時間|\d{1,2}\s*時|分以内).{0,10}面会/,
  },
} as const satisfies Stage6Rules;
