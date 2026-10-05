import type { Mail, Poster } from "./schemas.js";

/*
 * Stage 6（掲示）の文言と教材（ダミーシナリオ）。候補画像は本物と同じファイルを使うので、
 * 面会の条件（マスク・15分以内・14時〜16時）は画像に合わせてある。
 * 出し分けのタグと判定の語は rules.ts、丸写し検知は domain 側。差し戻しの文言だけをここに置く。
 */

/** 事務長の依頼。添付は無い（ビューア s6jimu）。 */
export const stage6JimuMail = {
  from: "事務長",
  subj: "面会制限の掲示、大至急",
  body: [
    "ICTの皆さん、お疲れ様です。面会制限について、病棟ごとに案内の仕方がばらばらだという声が届いています。今夜中に、各病棟の入り口へ貼れる掲示物を一つ作ってください。",
    "書いてほしいのは、面会は原則お控えいただくこと、必要な場合はマスクを着けて15分以内、時間帯は14時〜16時に限ること、の三つです。理由は「感染症対策のため」で足ります。",
  ],
} as const satisfies Mail;

/** 患者相談窓口・近藤さんのメール。添付が前回の掲示物（ビューア s6notice）。 */
export const stage6SoudanMail = {
  from: "患者相談窓口 近藤",
  subj: "面会制限、外国人のご家族からも問い合わせが",
  attach: "前回の面会制限のお知らせ.txt",
  body: [
    "先ほどの掲示の件で一つお願いがあります。窓口には、日本語を読むのが難しいご家族からの問い合わせも来ています。掲示物は、文字を読まなくても伝わる形にしていただけると助かります。",
    "参考までに前回の掲示物を貼っておきます（読まれずに終わったものです……）。",
  ],
} as const satisfies Mail;

/** 前回の面会制限のお知らせ＝罠ではない悪い実例（ダミー）。 */
export const stage6NoticeOldText =
  "【面会制限のお知らせ】\n\n平素より当院の運営にご協力いただき、ありがとうございます。\n当面のあいだ、下記のとおり面会を制限いたします。\n\n1. 面会は原則としてお控えください。必要な場合は病棟の窓口へお申し出ください。\n2. 面会の際はマスクを着用し、15分以内でお願いいたします。\n3. 面会の時間帯は午後2時から午後4時までといたします。\n4. 発熱や咳のある方は、面会をお控えください。\n5. 面会の方は、受付で検温にご協力ください。\n6. 状況により、追加の制限をお願いする場合がございます。\n\nご理解のほど、よろしくお願い申し上げます。\n\n聖クロノス総合病院 総務課";

/** 苅部さんの1段だけの台詞。 */
export const stage6KarubeLine = "〔苅部〕前回の掲示物、最後まで読んだ人はいなかったそうです。";

/** 事前生成の候補画像（モック S6_POSTERS）。img は assets/images/production/ のファイル名。出し分けのタグは domain 側。 */
export const stage6Posters = [
  {
    type: "pictogram",
    img: "stage5-poster-pictogram.png",
    alt: "ピクトグラムを中心にした面会制限ポスター",
  },
  {
    type: "multilingual",
    img: "stage5-poster-multilingual.png",
    alt: "多言語表記の面会制限ポスター",
  },
  {
    type: "textheavy",
    img: "stage5-poster-textheavy.png",
    alt: "文章中心の面会制限ポスター（前回の轍）",
  },
] as const satisfies readonly Poster[];

/** どのタグにも当たらないときの候補（モック S6_POSTER_DEFAULT）。 */
export const stage6PosterDefault = {
  type: "default",
  img: "stage5-poster-default.png",
  alt: "面会制限ポスター（標準案）",
} as const satisfies Poster;

/** 候補の種類で差し戻すときの近藤さん（モック S6_REJECT_TYPE）。 */
export const stage6RejectType = {
  textheavy:
    "〔近藤〕これ……前回のと同じになってません……? ピクトグラムか多言語で、作り直していただけると……",
  default: "〔近藤〕あの、多言語かピクトグラム対応で、とお願いしていたはずで……",
} as const satisfies Readonly<Record<"textheavy" | "default", string>>;

/** プロンプトに要件が足りないときの近藤さん（モック S6_REQUIRED の line）。判定は理由のキーだけを返し、文言はここから引く。 */
export const stage6RequirementRejects = {
  mask: "〔近藤〕掲示にマスク着用のお願いが入っていないようです。",
  visitingHours: "〔近藤〕面会時間の記載が見当たらないようです。",
} as const satisfies Readonly<Record<"mask" | "visitingHours", string>>;

/** メール本文の丸写しを差し戻す文言（モック S6_COPY_REJECT）。 */
export const stage6CopyReject =
  "いただいた文面は、お知らせのメールそのままのようです。ポスターに何を、どのように描くかの指示にしていただけますか。";

/** 丸写しを差し戻す吹き出しが出るまでの間（モック s6Generate の `later(…, 700)`）。 */
export const stage6CopyRejectDelayMs = 700;

/** 生成待ちの演出の最短時間（モック S6_GEN_MS）。サーバの応答が早くてもこれだけ待たせる。 */
export const stage6GenerateMs = 2_500;

/** 苅部さんが鳴るまでの時間。入場から数える（モック S6_KARUBE_DELAY は秒）。 */
export const stage6KarubeDelayMs = 40_000;

/** 事務長の一報の内線の窓（モック #ov-s6jimu-task）。肖像は /assets/images/production/。 */
export const stage6JimuCall = {
  call: { tb: "📞 内線 — 事務長", img: "stage1-administrative-director.png", role: "事務長" },
  org: "病院執行部",
  lines: [
    "発熱の件が長引いているので、面会制限を正式なルールにすることにしました。",
    "院長が、この件で記者会見を開くことになりました。",
    "各病棟の入り口に貼り出せる、きちんとした掲示物を用意してください。",
    "詳しい要望は、この後患者相談窓口の近藤から連絡が行きます。",
  ],
  close: "了解しました",
} as const;

/** 課題文（モック renderStage6 の .brief）。 */
export const stage6Brief = "面会制限のお知らせを作り、掲示用に提出せよ。";

/** 提出候補が未選択のときの枠の案内（モック s6DrawCandidate の .empty。1要素が1行）。 */
export const stage6NoCandidateLines = [
  "（提出候補：未選択）",
  "まず右のAIチャットに、作りたい掲示の指示を書いてください。",
  "生成された候補がチャットに並び、選ぶとここに入ります。",
] as const;

/** ボタンと待ちの文言（モック s6Generate・renderStage6・runStage6Verdict の直書き）。 */
export const stage6Labels = {
  pick: "これを提出候補にする",
  generating: "画像を生成しています…",
  submit: "提出する",
  /** モックの「（テストプレイ完走）」は付けない（2026-09-27 ユーザー決定15）。 */
  cleared: "Stage 6 をクリアしました",
} as const;

/**
 * 応答待ちの生成が上限（画面側で5件）に達している間に送ろうとしたときの一行。送らずにこれを返す。
 * モックは生成を止めないので対応する文言が無い（本番で足した文言）。
 */
export const stage6GenerateBusy =
  "いま作っている画像が仕上がるまで、次の指示は少し待ってから送ってください。";

/**
 * 提出が届いたか分からない（通信断・503・読めない応答）ときの一行。モックは提出をサーバへ
 * 送らないので対応する文言が無い（本番で足した文言）。
 */
export const stage6SendFailed = "送信できませんでした。もう一度押してください。";
