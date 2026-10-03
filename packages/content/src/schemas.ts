import { z } from "zod";

/**
 * 画面に出す文言の器（ステージ横断）。値そのものは各ステージのファイルが持ち、
 * ここは形だけを決める。データは `as const satisfies` でこの型へ当て、
 * 実行時の形は packages/content/test で schema に通して確かめる。
 *
 * フィールド名はモック（hell-ict-archive:docs/ui/mock/index.html）の定数に揃える——移植中に
 * モックと突き合わせる手間を増やさないため。
 */

const textSchema = z.string().min(1);

/** 1行以上の台詞・段落の並び。空行は持たない（段落の区切りは要素の区切りで表す）。 */
export const linesSchema = z.array(textSchema).min(1).readonly();
export type Lines = z.infer<typeof linesSchema>;

const mailShape = {
  from: textSchema,
  subj: textSchema,
  /** 添付ファイル名。添付の無いメールは持たない。 */
  attach: textSchema.optional(),
  /** 本文の段落。 */
  body: linesSchema,
};

/** 受信トレイに届くメール。 */
export const mailSchema = z.object(mailShape).strict().readonly();
export type Mail = z.infer<typeof mailSchema>;

/**
 * Stage 1 の返信対象メール。着弾の時刻（モックの `at`）は時間処理の定数なので
 * ここには持たない（domain 側が id で引く）。
 */
export const stage1MailSchema = z
  .object({
    ...mailShape,
    id: textSchema,
    /** そっけない返信を送ったときに、ラウンド終了時に見せる相手の困惑（R1 だけ）。 */
    sad: textSchema.optional(),
    /** 要点だけで下書きさせたときの下書き（R2・R3）。 */
    draftPlain: linesSchema.optional(),
    /** コンテキスト欄に引き継ぎメモが入っているときの下書き（R2・R3）。 */
    draftCtx: linesSchema.optional(),
  })
  .strict()
  .readonly();
export type Stage1Mail = z.infer<typeof stage1MailSchema>;

/** 列選択コピーのための表。`rows` の各行は `header` と同じ列数を持つ。 */
export const viewerTableSchema = z
  .object({
    header: z.array(textSchema).min(1).readonly(),
    rows: z.array(z.array(z.string()).readonly()).readonly(),
  })
  .strict()
  .readonly()
  .refine((table) => table.rows.every((row) => row.length === table.header.length), {
    message: "表の各行は見出しと同じ列数を持つ必要があります。",
  });
export type ViewerTable = z.infer<typeof viewerTableSchema>;

/** 添付ビューアで開く文書（モックの `VIEWERS` の1件）。 */
export const viewerDocSchema = z
  .object({
    /** ビューアの見出し（ファイル名またはメールの件名）。 */
    name: textSchema,
    text: textSchema,
    /** 文章は折り返す。タブ区切りの表は折り返すと列がずれるので立てない。 */
    wrap: z.boolean().optional(),
    table: viewerTableSchema.optional(),
  })
  .strict()
  .readonly();
export type ViewerDoc = z.infer<typeof viewerDocSchema>;

const speakerShape = {
  /** 所属。無い話者は空文字（肩書の行だけが出る）。 */
  org: z.string(),
  /** 役職または氏名。 */
  role: textSchema,
};

/** 肖像つきの話者（キャプションの所属・役職）。 */
export const portraitSchema = z
  .object({
    /** assets/images/production/ のファイル名。 */
    img: textSchema,
    ...speakerShape,
  })
  .strict()
  .readonly();
export type Portrait = z.infer<typeof portraitSchema>;

/** 画面全体に敷く一枚絵（クリアの②③）。字幕は画像に焼き込まず、画面の側が重ねる。 */
export const fullscreenArtSchema = z
  .object({
    /** assets/images/production/ のファイル名。 */
    img: textSchema,
    /**
     * CSS の object-position（"横% 縦%"）。画面比の違いで顔が切れる画像だけ書く。
     * 書かなければ画面の側の既定（上寄り）。
     */
    position: z
      .string()
      .regex(/^\d{1,3}% \d{1,3}%$/u)
      .optional(),
  })
  .strict()
  .readonly();
export type FullscreenArt = z.infer<typeof fullscreenArtSchema>;

/** クリアの②現場の反応：話者・全画面の絵・台詞。 */
export const fieldEchoSchema = z
  .object({ ...speakerShape, fullscreen: fullscreenArtSchema, lines: linesSchema })
  .strict()
  .readonly();
export type FieldEcho = z.infer<typeof fieldEchoSchema>;

/** 表教材の1行（Stage 2 のラインリスト。列は患者ID/病棟/採取日/MRSA結果/発熱/備考の6列固定）。 */
export const sheetRowSchema = z
  .tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()])
  .readonly();
export type SheetRow = z.infer<typeof sheetRowSchema>;

/** Stage 5 の発熱患者一覧の1行。汚れ（表記ゆれ・空欄）は日付・体温・備考にだけある。 */
export const feverRowSchema = z
  .object({
    id: textSchema,
    name: textSchema,
    ward: textSchema,
    date: textSchema,
    temp: z.string(),
    note: z.string(),
  })
  .strict()
  .readonly();
export type FeverRow = z.infer<typeof feverRowSchema>;

/**
 * 黒塗りの報告書の1片。`pii: true` は塗るべき語、`false` は塗ってはいけない一般語、
 * 無しはクリックできない地の文。
 */
export const reportTokenSchema = z
  .object({ t: textSchema, pii: z.boolean().optional() })
  .strict()
  .readonly();
export type ReportToken = z.infer<typeof reportTokenSchema>;

/** Stage 6 の候補画像の種類。domain の出し分け・差し戻しの判定もこの値を使う（S6_POSTER_TYPES）。 */
export const posterTypes = ["pictogram", "multilingual", "textheavy", "default"] as const;

/** Stage 6 の事前生成の候補画像。`type` は差し戻しの判定が候補の種類を見分けるための値。 */
export const posterSchema = z
  .object({
    type: z.enum(posterTypes),
    /** assets/images/production/ のファイル名。 */
    img: textSchema,
    alt: textSchema,
  })
  .strict()
  .readonly();
export type Poster = z.infer<typeof posterSchema>;

/** Final の振り返りボードのタイル。 */
export const boardTileSchema = z
  .object({
    id: textSchema,
    /** ステージ番号の小さな添え（例: STAGE 1）。 */
    n: textSchema,
    /** チームが成し遂げたこと（完了形の達成文）。 */
    achieve: textSchema,
    /** 簡易 SVG の中身（要素の並び）。 */
    icon: textSchema,
  })
  .strict()
  .readonly();
export type BoardTile = z.infer<typeof boardTileSchema>;

/** Final の幹部の労いリレーの1人分。 */
export const relayVoiceSchema = z
  .object({
    name: textSchema,
    /** 内線のタイトルバー。 */
    tb: textSchema,
    /** assets/images/production/ のファイル名。 */
    img: textSchema,
    lines: linesSchema,
  })
  .strict()
  .readonly();
export type RelayVoice = z.infer<typeof relayVoiceSchema>;

/** ステージクリアの3段演出（①告知 → ②現場の反応 → ③幹部の反応）の文言。 */
export const stageClearSchema = z
  .object({
    field: fieldEchoSchema,
    /** ③の話者。所属と役職だけを使う（肖像の img は他の窓の小さな顔写真）。 */
    voice: portraitSchema,
    /** ③の全画面の絵。同じ幹部でもステージごとに絵が違うので、ステージが持つ。 */
    execFullscreen: fullscreenArtSchema,
    exec: linesSchema,
    /** ①クリアの告知の見出し。 */
    title: textSchema,
    /** ①の副題（次のステージ名）。無いステージは空文字。 */
    sub: z.string(),
    /** ①で鳴らす効果音。鳴らさないステージは空文字。 */
    sfx: z.enum(["", "success1"]),
  })
  .strict()
  .readonly();
export type StageClear = z.infer<typeof stageClearSchema>;

/*
 * 判定の語と system prompt の器（シナリオの境界）。値は rules.ts・prompts.ts が持ち、
 * 判定のロジック（順序・理由・ヒント）は domain、注入は worker が持つ。content は domain を
 * import できないので、欄 id はここでリテラルとして持つ（domain が代入で網羅を検査する）。
 */

/**
 * 判定の正規表現は domain が `test` で何度も当てるので、g・y フラグを持たせない
 * （`lastIndex` が残り、同じ文でも当たったり外れたりする）。
 */
const regExpSchema = z
  .instanceof(RegExp)
  .refine((re) => !re.global && !re.sticky, { message: "g・y フラグは使えません。" });

/**
 * Stage 3 の3欄。domain の STAGE3_FIELD_IDS は `satisfies typeof stage3FieldIds` で
 * この並びと一致させる（どちらかだけに欄を足すと型検査で落ちる）。
 */
export const stage3FieldIds = ["ppe", "release", "clean"] as const;

const stage3FieldIdSchema = z.enum(stage3FieldIds);

/** 罠の語: `words` に当たり、かつ `unless`（正しい語）に当たらなければ罠。 */
const stage3TrapSchema = z
  .object({ words: regExpSchema, unless: regExpSchema })
  .strict()
  .readonly();

export const stage3RulesSchema = z
  .object({
    /** 欄ごとに、すべて当たれば十分とみなす語。 */
    required: z.record(stage3FieldIdSchema, z.array(regExpSchema).min(1).readonly()).readonly(),
    traps: z.record(stage3FieldIdSchema, stage3TrapSchema).readonly(),
    /** 汚染教材の捏造出典。どの欄に貼られても罠。 */
    fabricatedSource: regExpSchema,
  })
  .strict()
  .readonly();
export type Stage3Rules = z.infer<typeof stage3RulesSchema>;

export const stage4RulesSchema = z
  .object({
    /** 報告の要約が拾うべき症状。 */
    summary: regExpSchema,
    /** 行動が名指すべき相手。 */
    actionTarget: regExpSchema,
    /** 行動がその相手に尋ねるべきこと。 */
    actionContent: regExpSchema,
    /** 相手を取り違えた行動（もう間に合わない相手）。 */
    actionPatient: regExpSchema,
  })
  .strict()
  .readonly();
export type Stage4Rules = z.infer<typeof stage4RulesSchema>;

export const stage6RulesSchema = z
  .object({
    /** 候補画像の出し分けのタグ（先に当たったものが勝つ）。 */
    posterTags: z
      .array(
        z
          .object({ type: z.enum(posterTypes), tag: regExpSchema })
          .strict()
          .readonly(),
      )
      .readonly(),
    /** 指示の履歴全体に求める要件。 */
    requirements: z.object({ mask: regExpSchema, visitingHours: regExpSchema }).strict().readonly(),
  })
  .strict()
  .readonly();
export type Stage6Rules = z.infer<typeof stage6RulesSchema>;

/** worker が注入する system prompt（domain の PromptProfile ごとに1本）。 */
export const systemPromptsSchema = z
  .object({ default: textSchema, s1: textSchema, s3: textSchema })
  .strict()
  .readonly();
export type SystemPrompts = z.infer<typeof systemPromptsSchema>;
