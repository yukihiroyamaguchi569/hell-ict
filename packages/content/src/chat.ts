/*
 * AIチャットのシステム吹き出しの文言。モック hell-ict-archive:docs/ui/mock/index.html の handleLiveChatError・
 * handleLiveGateHit・rateLimitMessage の写し。どの応答にどれを出すかは画面の側が決める。
 */

/** 送信が失敗したときのシステム吹き出し（モック handleLiveChatError）。 */
export const chatSendNotices = {
  /** 400: 本文が長すぎる（4000字超）。 */
  tooLong: "長すぎるため送信できません。分割してください。",
  /** 400 のうち長さ以外（空白だけの本文など）。モックには無い文言。 */
  invalid: "この内容は送信できません。本文を確かめてください。",
  /** 422 pii_blocked: 送信前ゲートで止めた。 */
  piiBlocked: "個人情報を検知したため、送信をブロックしました。",
  /** 422 の本文に message が無いとき。 */
  refused: "AIが回答を拒否しました。",
  /** 409: 同じ送信を処理中。 */
  inProgress: "同じ内容を処理中です。少し待って再送してください。",
  /** 503・通信断・タイムアウト。 */
  unavailable: "AIの応答を取得できませんでした。再試行してください。",
} as const;

/** 429 の案内（モック rateLimitMessage）。秒数が読めなければ数字を出さない。 */
export const rateLimitNotice = (retryAfterSeconds: number | null): string =>
  retryAfterSeconds === null
    ? "送信が多すぎます。少し待ってからもう一度送ってください。"
    : `送信が多すぎます。${String(retryAfterSeconds)} 秒待ってからもう一度送ってください。`;

/** ステージの会話を用意できなかったとき（ai.status=failed）。モックには無い、V2 の決定。 */
export const chatPrepareFailed = {
  text: "会話の準備に失敗しました。",
  retry: "再試行",
} as const;

/** AIチャットペインの固定の文言（モック #pane-r のマークアップと aiPlaceholderBubble）。 */
export const chatPaneText = {
  title: "AIアシスタント",
  /** ここに出ているのが今のステージの会話1本だけであることを示す補助表示。 */
  scope: "このステージ",
  inputLabel: "AIへの指示",
  send: "送信",
  typing: "AIが入力中…",
  /** 台本応答の印（モック aiBubble の .tag）。実APIの応答と見分けるためだけの目印。 */
  scriptedTag: "台本",
  who: { user: "あなた", assistant: "AI", system: "システム" },
  /** 画像を読み込めなかったときの代替文（モック .s6-fallback）。 */
  imageMissing: (alt: string): string => `［画像プレビュー：${alt}］`,
} as const;
