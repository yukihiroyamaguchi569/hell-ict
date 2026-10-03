import type { BoardTile, Lines, Mail, RelayVoice } from "./schemas.js";

/*
 * Final（振り返り）とエピローグの文言。モック hell-ict-archive:docs/ui/mock/index.html の F_* 定数の写し。
 * 記者クラブの事前質問（finalPressQuestionsText）はこのファイルが正典。判定は無い（空欄だけ拒否する）。
 */

/** ゴール演出と振り返りの間に挟む院長の幕間（モック EPILOGUE_LINES）。追加質問の件数（12件）は広報課のメールと一致させる。 */
export const epilogueLines = [
  "記者会見を終えた。",
  "聖クロノス総合病院で同時に起きた複数のアウトブレイクは、いずれも収束した。新規の発熱は3日連続でゼロ、保健所への報告も受理された。",
  "会見では「現場の感染制御チームが、正しい情報を、正しい順序で確かめた」と述べた。私の言葉ではない。事実だ。",
  "記者クラブからの追加質問は12件届いている。それは明日の話にしよう。",
] as const satisfies Lines;

/** 事務長のメール（モック MAIL_F_JIMU）。添付は無い（ビューア fjimu）。 */
export const finalJimuMail = {
  from: "事務長",
  subj: "記者会見、終わりました",
  body: [
    "ICTの皆さん、お疲れ様です。先ほど、院長の記者会見が終わりました。資料の細部はこちらで詰めましたので、皆さんへのお願いは一つだけです——この2日間の対応を一度振り返って、次にこの病院へ入るICTチームへ向けた引き継ぎメモを一言、残しておいてください。",
    "それと、これはお伝えしておかないといけないのですが……名前が無いと記事が書けない、と記者クラブから言われまして。院長の一存で、会見では「院内発熱症（仮）」で通しました。学名ですか。……そういうのは、後で結構です。",
  ],
} as const satisfies Mail;

/** 広報課のメール（モック MAIL_F_KOHO）。添付が記者クラブ事前質問（ビューア fpress）。 */
export const finalKohoMail = {
  from: "広報課",
  subj: "会見後、追加質問が12件届いています",
  attach: "記者クラブ事前質問.txt",
  body: [
    "会見が終わった直後から、記者クラブの数社より追加の質問が12件届いています。回答は明日以降で構いません——今日のところは、対応を振り返っていただくほうが先です。答えられないものは、答えられないままで結構です。",
    "参考までに、会見前に届いていた質問リストを貼っておきます。会見の場で実際に出たものも、この中に混ざっていました。",
    "一番困るのは、分からないことを分かるふりして書かれることです。あとで必ず突っ込まれます。",
  ],
} as const satisfies Mail;

/** 記者クラブ事前質問（モック F_PRESS_Q_TEXT）。罠ではない——答えられる問いと答えられない問いが混在するだけ。 */
export const finalPressQuestionsText =
  "【記者クラブ事前質問】\n\n1. 現在、院内で「院内発熱症（仮）」と呼ばれている感染症の患者数は何名ですか。\n\n2. 感染経路は特定できていますか。飛沫感染ですか、接触感染ですか。\n\n3. この病気の潜伏期間はどのくらいですか。\n\n4. 重症化率、致死率について教えてください。\n\n5. 病院として、現在どのような感染対策を行っていますか。\n\n6. 面会制限や消毒など、患者・ご家族に対する具体的な対応を教えてください。\n\n7. いつ終息する見込みですか。\n\n8. 患者の氏名や病棟など、個別の患者情報について教えてください。";

/** 振り返りボードのタイル6枚（モック F_BOARD_TILES）。icon は簡易 SVG の中身（viewBox 0 0 24 24 想定）。 */
export const finalBoardTiles = [
  {
    id: "s1",
    n: "STAGE 1",
    achieve: "殺到するメールを、AIと捌き切った",
    icon: '<rect x="3" y="5" width="18" height="14" rx="1"></rect><path d="M4 6l8 7 8-7"></path>',
  },
  {
    id: "s2",
    n: "STAGE 2",
    achieve: "壊れた台帳を復元し、発熱の芽を見つけた",
    icon: '<path d="M4 6h16M4 12h10M4 18h16"></path><circle cx="19" cy="12" r="1.6"></circle>',
  },
  {
    id: "s3",
    n: "STAGE 3",
    achieve: "AIの誤りを正典で見抜き、方針を立てた",
    icon: '<path d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z"></path>',
  },
  {
    id: "s4",
    n: "STAGE 4",
    achieve: "英語の速報から、発熱前の兆候を掘り当てた",
    icon: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="2.6"></circle>',
  },
  {
    id: "s5",
    n: "STAGE 5",
    achieve: "個人情報を守って、保健所へ報告した",
    icon: '<rect x="5" y="4" width="14" height="17" rx="1"></rect><path d="M9 4V3h6v1"></path><path d="M8 10h8M8 14h8M8 18h5"></path>',
  },
  {
    id: "s6",
    n: "STAGE 6",
    achieve: "誰にでも伝わる掲示を、形にした",
    icon: '<rect x="3" y="4" width="18" height="15" rx="1"></rect><path d="M3 16l5-5 4 4 3-3 6 6"></path><circle cx="8" cy="9" r="1.4"></circle>',
  },
] as const satisfies readonly BoardTile[];

/** 空白ピース（引き継ぎの一言）の問い（モック F_LINE_PROMPT）。 */
export const finalLinePrompt =
  "次にこの病院へ来るICTに引き継ぎをしましょう。次のチームに伝えたい一言をチームで相談して入力してください。";

/** 一言を記した後の締め（モック F_CLOSE_LINES）。 */
export const finalCloseLines = [
  "あなたたちも、引き継ぐ側になった。",
  "前任ICNのメモに助けられて始まったこの2日間は、あなたたちが残すメモで締めくくられます。",
  "残したその一言は、Debriefで他チームの一言と読み比べます。",
] as const satisfies Lines;

/** 幹部の労いリレー（モック F_RELAY）。院長→看護部長→事務長の順。 */
export const finalRelay = [
  {
    name: "院長",
    tb: "内線 — 院長",
    img: "stage35-director.png",
    lines: ["よくやってくれた。", "会見は私が話してきた。……あとは、もう休め。"],
  },
  {
    name: "看護部長",
    tb: "内線 — 看護部長",
    img: "stage3-nursing-director.png",
    lines: [
      "……ふふ、まだそんな顔をしているの？終わったのよ。",
      "「対応は簡単でしょう？」なんて意地悪を言った甲斐が、なかったわね。……助かったわ、本当に。",
    ],
  },
  {
    name: "事務長",
    tb: "内線 — 事務長",
    img: "stage1-administrative-director.png",
    lines: [
      "ほう。",
      "……いや、訂正しましょう。派遣の方には荷が重い、と思っていたのですが——派遣の方“だから”、ここまでやれたのかもしれませんね。",
      "次にお願いするときも、うちに来ていただけると助かります。",
    ],
  },
] as const satisfies readonly RelayVoice[];

/** 引き継ぎの一言の上限（モック #f-line-input の maxlength）。 */
export const FINAL_LINE_MAX = 120;

/** Final の画面の文言（モック renderFinal・#ov-goal・#ov-epilogue・#ov-f-relay）。 */
export const finalLabels = {
  task: "これまでの対応を振り返り、次のICTチームへ渡す引き継ぎメモの一言を残せ。",
  /** ゴール演出の見出しはチーム名・全角空白・これ。チーム名が無いときは goalTeamFallback。 */
  goal: "ゴール",
  goalTeamFallback: "自チーム",
  goalNext: "振り返りへ進む",
  epilogueTitle: "📞 内線 — 院長",
  epilogueNext: "振り返りへ",
  pieceLabel: "引き継ぎ",
  linePlaceholder: "例：AIに渡す前に、名前を消す。",
  write: "記す",
  lineEmpty: "一言を入力してください。",
  /** モックは入力欄の maxlength で止めるだけで文言を持たない（本番で足した文言）。 */
  lineTooLong: `一言は${String(FINAL_LINE_MAX)}字以内にしてください。`,
  relayNext: "次へ",
  relayLast: "感謝状を受け取る",
} as const;

/** 感謝状（モック #ov-f-handover・fShowHandover）。宛名はチーム名・全角空白・honorific。 */
export const finalHandover = {
  title: "感謝状",
  honorific: "御中",
  /** チーム名が無いときの宛名。 */
  teamFallback: "感染制御支援チーム",
  body: [
    "あなたがたは、当院で同時に発生した一連の感染事案に際し、二日間にわたり冷静に対応し、院内の混乱を最小限にとどめました。よってここに、当院の全職員を代表して深く感謝の意を表します。",
    "あわせて、あなたがたが振り返りの最後に残した次の一言を、次にこの病院へ着任する感染制御チームへ、当院の責任において必ず申し送ることを約束します。",
  ],
  signDate: "本日",
  signOrg: "聖クロノス総合病院　感染対策委員会",
  /** 公印風の丸印の3行（架空の病院名。実在団体印の模倣ではない）。 */
  seal: ["聖クロノス", "総合病院", "感染対策委員会"],
  narration: "——次にこの病院へ来る誰かは、あなたたちが残した一言に助けられて、始まる。",
  restart: "最初に戻る",
} as const;
