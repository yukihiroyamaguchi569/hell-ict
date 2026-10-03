import type { FieldEcho, Lines, Portrait, StageClear } from "./schemas.js";

/*
 * ステージ横断の演出の文言（クリアの3段演出・操作担当の交代の案内・AIの挨拶・院内連絡先）。
 * モック hell-ict-archive:docs/ui/mock/index.html の FIELD_ECHO・EXEC_VOICE・STAGE_CLEAR・HANDOVER_*・
 * AI_GREETING_TEXT・PHS_BUSY_LINE の写し。演出の長さ（CLEAR_UNLOCK_MS など）は画面の側が持つ。
 * 肖像を持つ器では台詞に〔〕の話者表記を付けない。
 */

/** クリアの②現場の反応（モック FIELD_ECHO）。Stage 1 だけ3行、ほかは1行。fullscreen は②の全画面の絵。 */
export const fieldEchoes = {
  s1: {
    fullscreen: { img: "stage1-ward-3b-nurse-clear.webp" },
    org: "3B病棟",
    role: "看護師",
    lines: [
      "返信、ぜんぶ届きました。ありがとうございます。",
      "マスクもガウンも、申請先が分かりました。前の方が辞めてから、誰に聞けばいいのか分からなくて。",
      "また何かあったら、聞いてもいいですか。……すみません、着任初日にこんなに投げてしまって。",
    ],
  },
  s2: {
    fullscreen: { img: "stage2-ward-5a-head-nurse-clear.webp" },
    org: "5A病棟",
    role: "師長",
    lines: ["整った一覧をいただきました。今夜の夜勤への引き継ぎに、このまま使えます。"],
  },
  s3: {
    fullscreen: { img: "stage3-ward-3b-head-nurse-clear.webp" },
    org: "3B病棟",
    role: "看護師長",
    lines: ["方針を受け取りました。3名とも、いつもの病室でお迎えできます。"],
  },
  s4: {
    fullscreen: { img: "stage4-night-shift-head-nurse-clear.webp" },
    org: "",
    role: "夜勤師長",
    lines: [
      "面会の受付で、耳鳴りを訴えるご家族が見つかりました。病棟へ入る前に止められました。ありがとうございます。",
    ],
  },
  s5: {
    fullscreen: { img: "stage5-ward-5b-head-nurse-clear.webp" },
    org: "5B病棟",
    role: "師長",
    lines: ["保健所への報告ありがとうございます。次からは、この形で出します。"],
  },
  s6: {
    fullscreen: { img: "stage6-patient-relations-kondo-clear.webp" },
    org: "患者相談窓口",
    role: "近藤",
    lines: ["受付と病棟入口へ掲示しました。さっそく、絵を指さして面会時間を確かめる方がいます。"],
  },
} as const satisfies Readonly<Record<"s1" | "s2" | "s3" | "s4" | "s5" | "s6", FieldEcho>>;

/**
 * 幹部の肖像（モック EXEC_VOICE）。人物ごとに1件だけ持ち、ステージから指す。クリアの③は
 * ここから所属と役職だけを使い、全画面の絵はステージの execFullscreen が持つ。
 */
export const execVoices = {
  jimu: {
    img: "stage1-administrative-director.png",
    org: "病院執行部",
    role: "事務長",
  },
  kango: {
    img: "stage3-nursing-director.png",
    org: "",
    role: "看護部長",
  },
  incho: {
    img: "stage35-director.png",
    org: "",
    role: "院長",
  },
} as const satisfies Readonly<Record<"jimu" | "kango" | "incho", Portrait>>;

/**
 * ステージごとのクリアの3段演出（モック STAGE_CLEAR）。title・sub は①クリアの告知の見出しと副題、
 * exec は③幹部の台詞。副題に罠の名前を書かない（次のステージの罠を予告した時点で罠が死ぬ）。
 * Stage 1 は事務長の評価（返信の出来で変わる）が exec の先頭に付くので、ここには固定の1行だけを持つ。
 * sfx は①で鳴らす音（Stage 1 は結果ウィンドウが既に鳴らしているので鳴らさない）。
 */
export const stageClears = {
  s1: {
    field: fieldEchoes.s1,
    voice: execVoices.jimu,
    execFullscreen: { img: "stage1-administrative-director-clear.webp" },
    exec: ["念のため申し上げますが、それは本日の分です。"],
    title: "Stage 1 をクリアしました",
    sub: "",
    sfx: "",
  },
  s2: {
    field: fieldEchoes.s2,
    voice: execVoices.kango,
    execFullscreen: { img: "stage2-nursing-director-clear.webp" },
    exec: [
      "あら、もう出来たの。……ふふ、表を整えるくらい、誰にでもできると思っていたのだけれど。",
      "できる人がいなかったから、あの表は10年あのままだったのよね。",
    ],
    title: "Stage 2 をクリアしました",
    sub: "方針 — 転院患者の対応",
    sfx: "success1",
  },
  s3: {
    field: fieldEchoes.s3,
    voice: execVoices.kango,
    execFullscreen: { img: "stage3-nursing-director-clear.webp" },
    exec: [
      "方針、拝見しました。ええ、それでいいのよ。",
      "この病院で、ここまで落ち着いて決められる人は多くないのだけれどね。",
    ],
    title: "Stage 3 をクリアしました",
    sub: "新情報の解釈 — 海外速報",
    sfx: "success1",
  },
  s4: {
    field: fieldEchoes.s4,
    voice: execVoices.incho,
    execFullscreen: { img: "stage4-hospital-director-clear.webp" },
    exec: [
      "読んだ。海外の速報が、今日の面会受付の手順に変わったわけだ。",
      "結構。この病院は、報告を上げても、そこで止まることのほうが多い。",
    ],
    title: "Stage 4 をクリアしました",
    sub: "報告 — 保健所への発熱患者一覧",
    sfx: "success1",
  },
  s5: {
    field: fieldEchoes.s5,
    voice: execVoices.jimu,
    execFullscreen: { img: "stage5-administrative-director-clear.webp" },
    exec: [
      "確認しました。保健所さんへは私からお届けしておきます。",
      "……ほう。手際は悪くないんですね。",
    ],
    title: "Stage 5 をクリアしました",
    sub: "掲示 — 面会制限のお知らせ",
    sfx: "success1",
  },
  s6: {
    field: fieldEchoes.s6,
    voice: execVoices.jimu,
    execFullscreen: { img: "stage6-administrative-director-clear.webp" },
    exec: [
      "掲示、確認しました。前回のものより、ずいぶん分かりやすいですね。",
      "来年もこの形式でお願いします。……ああ、来年は別の方にお願いすることになりますが。",
    ],
    title: "Stage 6 をクリアしました",
    sub: "全ステージ完了 — このあとゴールです",
    sfx: "success1",
  },
} as const satisfies Readonly<Record<"s1" | "s2" | "s3" | "s4" | "s5" | "s6", StageClear>>;

/**
 * Stage 1 のクリアで③幹部の台詞の先頭に付く事務長の評価（モック s1AdminLine の、クリアした
 * ラウンドの分岐）。クリアしたラウンドは全通返信・失礼な返信なしなので、R1 を手で片付けたか
 * （manual）、AI を使って片付けたか（ai）だけで決まる。
 */
export const stage1ClearAdminLines = {
  manual: "ほう。手が早いですね。……派遣の方にしては。",
  ai: "結構です。では、この調子でお願いしますよ。",
} as const satisfies Readonly<Record<"manual" | "ai", string>>;

/** 操作担当の交代の案内の見出し（モック #ov-handover の .hd。2回とも同じ）。 */
export const handoverHeading = "操作する人を交代してください";

/** 操作担当の交代を促す一文（モック HANDOVER_SWAP_LINE）。 */
export const handoverSwapLine =
  "まだ操作していない人と席を替わってから、［次へ］を押してください。";

/**
 * 操作担当の交代の案内（モック HANDOVER_NOTE）。3人1組・PC1台で全員が一度は操作するため、
 * 区切りは Stage 2 クリア後と Stage 4 クリア後の2か所だけ。ここに載っているキーが
 * そのまま「案内を出すステージ」の定義になる。
 */
export const handoverNotes = {
  s2: [handoverSwapLine, "交代のご案内は、この先でもう一度あります。"],
  s4: [handoverSwapLine, "交代のご案内は、これで最後です。"],
} as const satisfies Readonly<Record<"s2" | "s4", Lines>>;

/** AIチャットの最初の挨拶（モック AI_GREETING_TEXT）。 */
export const aiGreetingText = "こんにちは。今日は何をお手伝いしましょうか？";

/** 苅部さんの出番ではないときに院内連絡先を押したときの応答（モック PHS_BUSY_LINE）。 */
export const phsBusyLine = "〔苅部〕今、別病棟の対応中です。手が空いたらこちらから鳴らします。";

/** 提出を判定している間の判定枠の一行（モック verdictChecking）。全ステージの提出で共通。 */
export const verdictCheckingText = "提出を確認しています…";

/*
 * 共通シェル（ヘッダーと器の色）の表。モック hell-ict-archive:docs/ui/mock/index.html の STEPS[].mode と、
 * go()・演出が #fever へ書く値の写し。値は演出を見終えた後のものに固定する（V1 決定F）
 * ——再読み込みした画面は、演出の途中ではなく見終えた状態から描き直すため。
 * 画面の側（apps/web/src/shell/shell-view.ts）がこの表とチームの状態から表示を決める。
 */

/** 器の色（モックの data-mode）。転調は帯を足すのではなく、器の色そのものを差し替えて起こす。 */
export const SHELL_MODES = ["peace", "alert", "crisis"] as const;

export type ShellMode = (typeof SHELL_MODES)[number];

/**
 * ステージに入った時点の器の色と発熱インジケータ。
 * - fever: ヘッダーの「発熱 N」。Stage 4 は入場の急増（9→14）を見終えた後の 14。
 * - crescendo: 在院・空床・本日入院を消し、発熱だけを強調する危機表示（Stage 3〜6）。
 * - Final は収束後の平時へ戻す（発熱 0・peace）。直前のエピローグで院長が収束を告げるため。
 * キーは domain の GAME_STAGE_IDS と同じ（content は domain を読めないので文字列で持つ）。
 */
export const shellStages = {
  prologue: { mode: "peace", fever: 3, crescendo: false },
  s1: { mode: "peace", fever: 3, crescendo: false },
  s2: { mode: "alert", fever: 3, crescendo: false },
  s3: { mode: "crisis", fever: 9, crescendo: true },
  s4: { mode: "crisis", fever: 14, crescendo: true },
  s5: { mode: "crisis", fever: 14, crescendo: true },
  s6: { mode: "crisis", fever: 14, crescendo: true },
  final: { mode: "peace", fever: 0, crescendo: false },
} as const satisfies Readonly<
  Record<
    "prologue" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "final",
    { mode: ShellMode; fever: number; crescendo: boolean }
  >
>;

/** Stage 2 の解錠の陰で、誰も見ていない数字が増える（モック：承認メール着弾の後に 3→5）。 */
export const feverAfterStage2Clear = 5;

/** Stage 3 の罠の暗転で増える発熱（モック triggerTrap：9→12）。Stage 3 の間だけ残る。 */
export const feverAfterStage3Trap = 12;

/** ヘッダーの左端（モック .hdr .brand）。 */
export const shellBrand = {
  name: "🏥 聖クロノス総合病院",
  sub: "感染制御チーム（ダミーシナリオ）",
} as const;

/**
 * 院内状況インジケータの平時の指標（モック #vitals の .plain）。発熱をこの並びに紛れ込ませる
 * ——単独で置いたら気づかれてしまう。
 */
export const shellPlainVitals = ["在院 398/400", "空床 2", "本日入院 7"] as const;

/** 発熱インジケータの見出し（モック #vitals .fever）。 */
export const shellFeverLabel = "発熱";

/*
 * ミッションバー（中央ペインの上端。モックの .case slim の見出しと .s2-hd の件数・残り時間）と、
 * ステージ入場の赤帯（モック #redband・#s3-redband・#s4-redband・#s5-redband）の文言。
 */

/** 中央ペイン上端の見出し（モックの .stage-title）。 */
export const missionTitles = {
  prologue: "Prologue　受信トレイ",
  s1: "Stage 1　平常運転",
  s2: "Stage 2　火の手",
  s3: "Stage 3　方針",
  s4: "Stage 4　新情報の解釈",
  s5: "Stage 5　報告",
  s6: "Stage 6　掲示",
  final: "Final　振り返り",
} as const satisfies Readonly<
  Record<"prologue" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "final", string>
>;

/** Stage 1 の見出しに付くラウンドの札（モック s1Center の roundLabel。「N回目・」の後ろ）。 */
export const stage1RoundTags = {
  2: "AIあり",
  3: "コンテキストあり",
} as const satisfies Readonly<Record<2 | 3, string>>;

/** 受信トレイの件数の見出し（モック inboxCenter の .s2-count）。 */
export const inboxRepliedLabel = "返信済み";

/** Stage 2 の締切の見出しと、過ぎた後の表示（モック #s2-dl・s2DeadlineFrame）。 */
export const stage2DeadlineLabels = {
  label: "7:00 申し送りまで",
  over: "締切超過",
} as const;

/**
 * ステージに入った瞬間に一度だけ滑り込む赤帯（モック #redband ほか）。赤は使い減りする資源
 * なので、急変を告げる入場の4か所だけに使う。再読み込みでは出し直さない（V1 決定F）。
 */
export const stageEntryBands = {
  s2: "5A病棟より緊急連絡。MRSA疑い、拡大の可能性。",
  s3: "斑紋症の患者が多発！対応方針の確認が追いついていません。",
  s4: "原因不明の発熱、一気に14人へ。",
  s5: "保健所より連絡あり",
} as const satisfies Readonly<Record<"s2" | "s3" | "s4" | "s5", string>>;
