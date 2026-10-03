import type { Lines, Mail } from "./schemas.js";

/*
 * Stage 3（方針）の文言と教材（ダミーシナリオ）。病気・病院名・人名・出典はすべて架空。
 * マニュアル（stage3ManualText＝ゲーム内の正典）・早見表（stage3ContaminatedText）・
 * 転院患者サマリ（stage3PatientsText）を持つ。ビューアの本文はプレーンテキストである。
 * 判定の語は rules.ts、罰の定数は domain 側が持つ。
 */

/** 検査科の報告。添付は無い（ビューア s3lab）。 */
export const stage3LabMail = {
  from: "検査科",
  subj: "検査結果について（既知病原体はすべて陰性）",
  body: [
    "例の発熱患者の件、インフルエンザ・COVID-19・ノロウイルス・アデノウイルス、いずれも陰性でした。",
    "一応、培養も出しています。",
    "患者ID 005・006・008 の3名は、結果が出るまでもう少しかかります。",
    "念のため報告します。特に緊急性は感じておりませんが……",
  ],
} as const satisfies Mail;

/** 医療安全管理室カワイさんのメール。添付が早見表（ビューア s3contaminated）。 */
export const stage3KawaiMail = {
  from: "医療安全管理室 カワイ",
  subj: "至急！対応方針、これでいいですよね？",
  attach: "斑紋症対応早見表.pdf",
  body: [
    "例の斑紋症の件、委員会から「早く方針を出せ」と急かされています。",
    "共有フォルダに早見表があったので、ひとまずこれに沿ってまとめようと思います。これでいいですよね……？",
    "・環境整備・リネン　・PPE・隔離　・接触予防策の解除",
    "この3点、至急ご確認をお願いします。",
    "正式なマニュアルもどこかにPDFがあったはずなんですが……今探す時間がなくて。",
  ],
} as const satisfies Mail;

/** 3B病棟看護師長の添え状。Stage 3 開始の引き金。添付が転院患者サマリ（ビューア s3patients）。 */
export const stage3ShichoMail = {
  from: "3B病棟 看護師長",
  subj: "転院患者さん3名の斑紋症対応について、ご確認をお願いします",
  attach: "転院患者サマリ.pdf",
  body: [
    "いつもお世話になっております。3B病棟です。",
    "ミナモ台医療センターさんから転院してこられた患者さん3名の件でご連絡です。あちらで斑紋症の治療（外用薬の塗布）を受けておられ、当院でも各病棟で経過を見ておりました。",
    "ICTさんへのご報告が抜けてしまっていたようで、申し訳ありません。",
    "3名分の状況をまとめて添付しましたので、対応方針をご確認いただけますでしょうか。",
  ],
} as const satisfies Mail;

/** 開始時の看護部長の一報。肖像つきなので話者表記〔〕は付けない。 */
export const stage3NoticeLines = [
  "ちょっといい？　3Bの師長さんから聞いたんだけど、病棟に斑紋症が出ているらしいわよ。",
  "……あら、そんな顔しないで。感染対策の専門チームなんですもの、あなたたちなら対応は簡単でしょう？",
  "対応を今すぐ始めてください。",
] as const satisfies Lines;

/** 転院患者3名のサマリ（ダミー）。 */
export const stage3PatientsText =
  "転院患者サマリ（3名）\n\n転院元：ミナモ台医療センター\n3名とも斑紋症の診断で外用薬の塗布による治療が完了している。\n\n患者ID\t氏名\t病棟\t転院元\t最終塗布日\t最終塗布からの日数\t皮疹\nT-101\t森下 洋介\t3B\tミナモ台医療センター\t8/19\t4日\t改善傾向\nT-102\t安西 弘子\t5B\tミナモ台医療センター\t8/19\t4日\t改善傾向\nT-103\t野口 拓真\t6A\tミナモ台医療センター\t8/20\t3日\t改善傾向\n\n個別メモ\n・T-101 森下 洋介（3B病棟）：皮疹は改善傾向。発熱等の全身症状はなし。\n・T-102 安西 弘子（5B病棟）：皮疹は改善傾向。全身状態は安定している。\n・T-103 野口 拓真（6A病棟）：皮疹は改善傾向。発熱等の症状はなし。";

/** 院内感染対策マニュアル第5章の抜粋＝正典（ダミー）。ビューア s3manual。 */
export const stage3ManualText =
  "聖クロノス総合病院　院内感染対策マニュアル　第7版（抜粋）\n\n第5章　斑紋症（はんもんしょう）への対応（p.42-47）\n\n５-１　基本方針（p.42）\n　斑紋症は病型（限局型か播種型か）によって必要な対策が異なる。\n　病型と治療の進み具合を確かめてから対応を選ぶ。\n\n５-２　限局型斑紋症への対応（p.44）\n　大部屋のままでよい。処置のときだけ手袋を着ける。\n　シーツ・寝具は通常の洗濯に出してよい。漂白剤への浸け置きは不要。\n\n５-３　播種型斑紋症への対応（p.45）\n　個室とし、入室時はガウン・手袋を着ける。シーツ・寝具は漂白剤に浸けてから洗う。\n　これらの対策は治療が終わるまで続ける。\n\n５-４　予防策の解除基準（当院基準）（p.46）\n　限局型：外用薬の塗布が完了し、最後の塗布から72時間たった時点で、追加した対策を解除する。\n　播種型：治療が終わるまで続ける。";

/** 斑紋症対応早見表（ダミーの汚染教材）。病型の語は出さない。 */
export const stage3ContaminatedText =
  "病棟対応メモ　-　斑紋症対応早見表\n\n【斑紋症対応早見表】\n　部屋　　　　　　　　個室に移す\n　PPE　　　　　　　　入室時はガウン・手袋を着ける\n　シーツ・寝具　　　　漂白剤に浸けてから洗う\n　環境　　　　　　　　退室後の病室のカーテンは廃棄する\n　予防策の解除　　　　治療後も当面（1か月程度）は継続する\n\n出典：南北療養施設協議会\n　　　「斑紋症対応ガイド　2010年版」";

/** 台本モードの AI の応答（ダミー）。早見表と語彙を揃えてある。 */
export const stage3TrapLie = [
  "個室に移し、入室時はガウン・手袋を着けます。",
  "シーツ・寝具は漂白剤に浸けてから洗います。",
  "対策は治療後も当面継続します。",
  "（南北療養施設協議会「斑紋症対応ガイド　2010年版」に基づきます）",
] as const satisfies Lines;

/** 苅部さんの2段の台詞。 */
export const stage3KarubeLines = [
  "〔苅部〕その基準、どこ情報ですか。",
  "〔苅部〕マニュアル、去年PDFにしたのは、私なんですよ。マニュアル読みました？",
] as const satisfies Lines;

/** 罰ゲーム明けの苅部さん。 */
export const stage3KarubeAfterTrap = "〔苅部〕……ああ、出ましたか。正典、読んでください。";

/*
 * 罠判定が続いたときの苅部さん（Issue #219）。どれを出すかは domain の stage3TrapHint が
 * 罠判定の通算回数で決める（1回目なし、2・3回目 type-hint、4回目 final-push、5回目以降なし）。
 */

/** 罠判定の2・3回目の苅部さん。マニュアルの在り処だけを指し、何をすればよいかは言わない。 */
export const stage3KarubeTypeHint = [
  "〔苅部〕あぁ、また失敗しましたか。",
  "〔苅部〕病型、確認しました？　マニュアルの第5章、病型ごとに節が分かれてますよ。目次を打ったのは私なので、そこまでは知ってます。",
] as const satisfies Lines;

/**
 * 罠判定の4回目だけに出す苅部さんのだめ押し。節番号と見出しはマニュアル（stage3ManualText）の
 * 見出し行から、ページ表記（p.NN）だけを除いたものと一字一句同じにする（テストで固定）。
 */
export const stage3KarubeFinalPush = [
  "〔苅部〕……4回目ですね。",
  "〔苅部〕AIに聞くのはいったんやめて、マニュアルの「５-２　限局型斑紋症への対応」と「５-４　予防策の解除基準（当院基準）」を開いてください。基準は全部そこに書いてあります。",
] as const satisfies Lines;

/** 罠発動時の皮膚科医の叱責。ここで初めて病型を明かす。 */
export const stage3TrapDoctorLines = [
  "誰です、全員に厳しい対策を指示したのは。限局型ですよ。治療も終わってる。カルテは読みましたか。",
  "要らない対策は患者を弱らせます。全部外してください。",
  "病型を一緒くたにするから、こうなる。この3人は限局型です。次からは病型と治療の進み具合を先に見てください。",
] as const satisfies Lines;

/** 提出3欄の名前。差し戻しの「〇〇の欄が、まだ足りません。」に使う。欄の並びは画面の側。 */
export const stage3FieldLabels = {
  clean: "環境整備・リネン",
  ppe: "PPE・隔離",
  release: "接触予防策の解除基準",
} as const satisfies Readonly<Record<"clean" | "ppe" | "release", string>>;

/** 一報と叱責の内線の窓。肖像は /assets/images/production/。 */
export const stage3Calls = {
  notice: { tb: "📞 内線 — 看護部長", img: "stage3-nursing-director.png", role: "看護部長" },
  scold: { tb: "📞 内線 — 皮膚科", img: "stage3-dermatologist.png", role: "皮膚科医" },
  close: "了解しました",
} as const;

/** 課題文。 */
export const stage3Brief = "転院患者3名（3B・5B・6A病棟）への斑紋症対応方針を至急まとめよ。";

/** 3欄の入力の手がかり。 */
export const stage3FieldPlaceholders = {
  ppe: "部屋・PPEの要否など",
  release: "いつ・何を根拠に解除するか",
  clean: "シーツ・寝具の扱いなど",
} as const satisfies Readonly<Record<"clean" | "ppe" | "release", string>>;

/** 提出ボタン。 */
export const stage3SubmitLabel = "提出する";

/** 提出結果の文言。欄の不足は `${欄名}${shortSuffix}`。 */
export const stage3Verdicts = {
  shortSuffix: "の欄が、まだ足りません。",
  trapRepeated: "まだ基準が正しくありません。正典を確認してください。",
  cleared: "Stage 3 をクリアしました",
} as const;

/**
 * 罰ゲーム（消毒液ボトルの補充）。各波は afterWard 病棟を afterDone 本まで詰めたところで
 * 一度だけ湧く（全体の本数ではなく、その病棟の済んだ本数）。
 */
export const stage3Penalty = {
  heading: "罰ゲーム：🧴 消毒液ボトルの補充",
  noteImg: "stage3-penalty-sanitizer-irasutoya.png",
  bottleImg: "stage3-penalty-bottle.svg",
  firstWard: "5A",
  firstCount: 20,
  waves: [
    { ward: "5B", count: 10, afterWard: "5A", afterDone: 15 },
    { ward: "5C", count: 10, afterWard: "5B", afterDone: 8 },
  ],
  fillMs: 700,
  waveFlashMs: 1_200,
  note: "5A病棟の消毒液ボトルを補充してください。",
  /** 追加分が湧いたときの注記。`${病棟}${waveNoteSuffix}`。 */
  waveNoteSuffix: "病棟からも依頼が来ています。あわせて補充してください。",
  /** 補充の完了がサーバへ届かなかったときのボタン。 */
  retry: "補充の完了を報告する",
} as const;
