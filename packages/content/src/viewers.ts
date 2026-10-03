import { finalJimuMail, finalKohoMail, finalPressQuestionsText } from "./final.js";
import type { Mail, ViewerDoc } from "./schemas.js";
import { stage1MemoText } from "./stage1.js";
import {
  stage2AddendumMail,
  stage2AddendumSheetText,
  stage2Mail,
  stage2SheetText,
} from "./stage2.js";
import {
  stage3ContaminatedText,
  stage3KawaiMail,
  stage3LabMail,
  stage3ManualText,
  stage3PatientsText,
  stage3ShichoMail,
} from "./stage3.js";
import { stage4DirectorMail, stage4ReportText } from "./stage4.js";
import { stage5FeverSheetText, stage5FeverTable, stage5JimuMail } from "./stage5.js";
import { stage6JimuMail, stage6NoticeOldText, stage6SoudanMail } from "./stage6.js";

/*
 * 添付ビューアで開く文書（モック hell-ict-archive:docs/ui/mock/index.html の VIEWERS）。
 * ビューアは「届いた添付ファイル」を読むだけの器で、編集はできない。
 * 添付の無いメールも、中央ペインに本文を出す場所が無いステージのために
 * 件名を見出しにしてここで読ませる（モックの簡略化をそのまま移す）。
 */

/** 添付の無いメールをビューアで読ませる形（段落は空行で区切る）。 */
const mailViewer = (mail: Mail): ViewerDoc => ({
  name: mail.subj,
  text: mail.body.join("\n\n"),
  wrap: true,
});

/**
 * 本文（添え状）と添付を1つのビューアにまとめて読ませる形。本文と添付を分ける
 * 器が無いモックの簡略化で、見出しは添付のファイル名になる。
 */
const mailWithAttachment = (
  mail: Mail & { readonly attach: string },
  attachmentText: string,
): { readonly name: string; readonly text: string } => ({
  name: mail.attach,
  text: `${mail.body.join("\n\n")}\n\n---\n\n📎 ${mail.attach}\n\n${attachmentText}`,
});

export const viewerDocs = {
  /* 前任ICNの引き継ぎメモの控え。受信トレイの1通は60秒で消えるが、R3の
     「コンテキスト欄に丸ごと貼る」導線はこちらを指す。 */
  s1memo: { name: "引き継ぎメモ_前任ICN.txt", text: stage1MemoText, wrap: true },
  /* Stage 2 の添付（配布版と、締切超過で着弾する追加分）。タブ区切りの表なので折り返さない。 */
  main: { name: stage2Mail.attach, text: stage2SheetText },
  add: { name: stage2AddendumMail.attach, text: stage2AddendumSheetText },
  /* Stage 3。マニュアルと早見表は別のキーに分け、混ざりようのない形にする。 */
  s3manual: { name: "院内感染対策マニュアル.pdf", text: stage3ManualText },
  s3contaminated: { name: stage3KawaiMail.attach, text: stage3ContaminatedText },
  s3lab: mailViewer(stage3LabMail),
  s3patients: mailWithAttachment(stage3ShichoMail, stage3PatientsText),
  /* Stage 5。table を持つ添付だけが列選択コピーを出す。既定は全列ON。 */
  /* Stage 4 の速報論文。モックは専用の器（#ov-s4-report）で開くが、ここでは共通のビューアに載せる。
     ［コピー］は英語本文をそのまま渡す。 */
  s4report: { name: stage4DirectorMail.attach, text: stage4ReportText, wrap: true },
  s5list: { ...mailWithAttachment(stage5JimuMail, stage5FeverSheetText), table: stage5FeverTable },
  /* Stage 6。事務長のメールは添付が無い。近藤さんの本文と以前の掲示物は
     1つのビューアにまとめる。 */
  s6jimu: mailViewer(stage6JimuMail),
  s6notice: { ...mailWithAttachment(stage6SoudanMail, stage6NoticeOldText), wrap: true },
  /* Final。事務長のメールは添付が無い。広報課の本文と記者クラブ事前質問は1つのビューアにまとめる。 */
  fjimu: mailViewer(finalJimuMail),
  fpress: { ...mailWithAttachment(finalKohoMail, finalPressQuestionsText), wrap: true },
} as const satisfies Record<string, ViewerDoc>;

export type ViewerId = keyof typeof viewerDocs;

/**
 * ビューアのコピーがクリップボードに拒まれたときのボタン表示。モックは失敗を握りつぶして
 * 「コピーしました」を出していたため、モックに対応する文言が無い（本番で足した文言）。
 */
export const viewerCopyFailedLabel = "コピーできませんでした";
