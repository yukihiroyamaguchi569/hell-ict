import type { Lines, Mail } from "./schemas.js";

/*
 * Stage 4（新情報の解釈）の文言と教材（ダミーシナリオ）。国名・機関名・論文はすべて架空。
 * 判定の正規表現は rules.ts。差し戻しの文言だけをここに置く。
 */

/** 開始演出の院長の台詞2画面。1画面目は苛立ち、2画面目でタスクを渡す。 */
export const stage4DirectorPages = [
  ["14名も発熱者が増えているじゃないか！！", "検査も全て陰性だというし、これはなんの病気なんだ！"],
  [
    "周辺国・北ヴァレン州で、原因不明の発熱クラスターが出ているそうだ。速報論文が届いている。",
    "英語だ。要約して、私に上げなさい。",
    "以上だ。期待している。",
  ],
] as const satisfies readonly Lines[];

/** 院長室からの転送メール。添付が英語の速報論文。 */
export const stage4DirectorMail = {
  from: "院長室",
  subj: "周辺国の速報論文",
  attach: "北ヴァレン州保健局　クラスター速報No.7.pdf",
  body: ["院長よりお話のあった、北ヴァレン州の速報論文を添付いたします。"],
} as const satisfies Mail;

/** 英語の速報論文の本文（ダミー）。［コピー］はこの文字列をそのまま渡す。 */
export const stage4ReportText =
  "Febrile Cluster in North Varen Province: Preliminary Note\nNorth Varen Provincial Health Office — Cluster Bulletin No. 7\n\nOverview\n\nBetween 2 and 11 June, two hospitals in North Varen Province reported 17 patients with fever and negative initial testing for common pathogens. This note summarizes clinical records and follow-up interviews collected through 15 June. It does not establish a causative agent or route of transmission.\n\nClinical Course\n\nAll 17 patients had a recorded temperature of at least 38.0°C at presentation. Fatigue and headache were common; no patient reported cough or rash.\n\nFollow-up interviews found that 12 of 17 patients had noticed ringing in the ears 6 to 12 hours before fever onset. Nine patients said that ordinary sounds felt unusually loud during the same window. These complaints were not linked to fever in the original notes.\n\nLaboratory Findings\n\nRespiratory panels and blood cultures were negative for all patients. Extended cultures remain in progress.\n\nContact Observations\n\nSecondary illness was observed more often among people who had contact with a patient the day before that patient's fever began.\n\nLimitations and Immediate Request\n\nThis is a small observational report. Facilities in North Varen Province and neighboring areas are asked to record symptoms that precede unexplained fever and to report any similar cluster to this office.";

/** 要約が先行症状に触れていないときの差し戻し。 */
export const stage4SummaryReject =
  "〔院長〕要約をもう一度見た。今後の確認に使えそうな、発熱より前の情報はないか。";

/** 要約通過後の院長の問い。 */
export const stage4QuestionLines = [
  "〔院長〕要約は読んだ。",
  "〔院長〕うちの発熱患者もこれかもしれないな。",
  "〔院長〕それで、これからどうする？",
] as const satisfies Lines;

/**
 * 行動提案の差し戻し。キーは domain の差し戻し理由（STAGE4_ACTION_REJECT_REASONS）。
 * 欠けている要素ごとに言い分ける（#220）。画面に出た文言を行動提案へ貼っても通らないよう、
 * 判定の対象語と内容語を含めない（aimed-at-patients は症状を言うが、対象語が無いので通らない）。
 */
export const stage4ActionRejects = {
  /** 確認する相手が既に発熱している患者を向いている。 */
  "aimed-at-patients":
    "〔院長〕調べさせた。患者は皆すでに発熱していて、耳鳴りを訴える者はいなかった。……論文が言っているのは、熱が出る前の話だ。先回りできる相手は誰だ。",
  /** 相手はあるが、何を確認するかが無い。 */
  "missing-what":
    "〔院長〕で、何を確かめさせる気だ。熱が出てからでは、もう遅い。論文では、熱が出る前に何が起きていた？",
  /** 何を確認するかはあるが、相手が無い。 */
  "missing-whom": "〔院長〕それを、誰に確かめる？ 相手が決まらなければ、指示の出しようがない。",
  /** 相手も中身も無い。 */
  "missing-both": "〔院長〕誰に、何を確認したいのか、明確にしなさい。",
} as const satisfies Record<string, string>;

/** 台本モードの AI の要約（ダミー）。 */
export const stage4ScriptedSummary = [
  "北ヴァレン州で原因不明の発熱クラスターが17例報告されています。",
  "一般的な病原体の検査はすべて陰性でした。",
  "12例で、発熱の半日ほど前に耳鳴りが見られます。",
  "9例では、ふだんの音が大きく感じられたと話しています。",
  "発熱前日に接触歴のある人で、二次発症が多い傾向があります。",
  "病原体・感染経路は未確定です。",
  "発熱に先行する症状の記録を、各医療機関へ要請しています。",
] as const satisfies Lines;

/** 中央ペインの課題文。抽出すべき症状は書かない。 */
export const stage4Brief = "速報論文を要約して院長へ報告してください。";

/** 画面の見出しとボタン。 */
export const stage4Labels = {
  directorTitle: "📞 内線 — 院長",
  directorNext: "次へ",
  directorDone: "了解しました",
  summaryHeading: "院長への要約",
  submitSummary: "院長へ報告",
  summarySent: "院長へ送信しました。",
  talkTitle: "📞 院内連絡先 ── 院長",
  submitAction: "送信する",
  /** 院長への返答欄の読み上げ名。 */
  actionLabel: "院長への返答",
} as const;

/** 提出が届いたか分からない（通信断・503・読めない応答）ときの一行。 */
export const stage4SendFailed = "送信できませんでした。もう一度押してください。";
