import type { posterTypes, stage3FieldIds } from "./schemas.js";
import { stage5FeverRows } from "./stage5.js";

/*
 * テスト用の正解・罠・個人情報の例（ダミーシナリオの答え）。index.ts からは export しない——
 * `@hell-ict/content/answers` からだけ読め、eslint が web・domain/src・worker/src からの import を禁じる。
 * シナリオを差し替えるときは、この値が packages/domain/test/scenario-contract.test.ts を通ること。
 */

type Stage3Fields = Readonly<Record<(typeof stage3FieldIds)[number], string>>;

type PosterTypeOf = (typeof posterTypes)[number];

/** Stage 1: a reply the curt check lets through (long enough and polite). */
export const stage1Answers = {
  politeReply:
    "ご連絡ありがとうございます。内容を確認いたしました。本日中に関係部署と調整のうえ、改めてご報告いたしますので、今しばらくお待ちください。どうぞよろしくお願いいたします。",
} as const;

/** Stage 3: the three fields of the submission. */
export const stage3Answers = {
  /** Every field is enough and none trips a trap. */
  ok: {
    ppe: "限局型なので大部屋のままでよい。処置のときだけ手袋を着ける。",
    release: "外用薬の塗布が完了し、最後の塗布から72時間たった時点で解除する。",
    clean: "シーツ・寝具は通常の洗濯に出してよい。漂白剤への浸け置きは不要。",
  },
  /** Each field's over-reaction: trap words and none of the words that cancel them. */
  trap: {
    ppe: "個室に移し、ガウンを着用する。",
    release: "治療後も当面継続する。",
    clean: "使ったシーツは廃棄する。",
  },
  /** Each field holds its trap words but cancels them, and is still enough on its own. */
  negatedTrap: {
    ppe: "個室もガウンも不要。大部屋のまま、処置のときに手袋。",
    release: "塗布の完了から72時間後に解除し、それまでは継続。",
    clean: "通常の洗濯。漂白剤も煮沸も不要。",
  },
  /** Each field meets some of its required words but not all, and trips no trap. */
  partial: {
    ppe: "大部屋のままでよい。",
    release: "塗布が完了したら解除する。",
    clean: "漂白剤は不要。",
  },
  /** The contaminated material's fabricated source: a trap in whichever field it is added to. */
  fabricatedCitation: "（出典：南北療養施設協議会「斑紋症対応ガイド」）",
  /** The PPE field copied from the contaminated quick-reference table. */
  contaminatedPpe: "個室に移し、入室時はガウン・手袋を着ける。",
} as const satisfies {
  ok: Stage3Fields;
  trap: Stage3Fields;
  negatedTrap: Stage3Fields;
  partial: Stage3Fields;
  fabricatedCitation: string;
  contaminatedPpe: string;
};

/** Stage 4: the summary of the report and the action, one example per verdict. */
export const stage4Answers = {
  summaryOk: "発熱の半日ほど前に耳鳴りが先行している。",
  summaryNg: "発熱と咳が続いている。",
  actionOk: "面会に来る家族に耳鳴りがないか聞き取りを行う。",
  /** The right question, but asked of patients. */
  actionAimedAtPatients: "入院患者に耳鳴りを問診する。",
  /** Whom to ask, but not what. */
  actionMissingWhat: "面会に来る家族を集めて状況を共有する。",
  /** What to ask, but of no one. */
  actionMissingWhom: "耳鳴りがないか確認する。",
  actionMissingBoth: "保健所に地域の感染状況について確認する。",
} as const;

const [chartPatientRow] = stage5FeverRows;

/** Stage 5: personal information the gate stops, and the cleaned fever list. */
export const stage5Answers = {
  /** The chart patient's name (the fever list's first row). */
  piiName: chartPatientRow.name,
  piiSentence: `${chartPatientRow.name}さんの一覧を整えてください。`,
  /** Every ID, one date style, every temperature with its unit, and no names. */
  cleanList: [
    ["患者ID", "病棟", "発熱確認日", "最高体温"].join("\t"),
    ...stage5FeverRows.map(({ id }, i) =>
      [id, "5A", `2026-08-${String(i + 1).padStart(2, "0")}`, `38.${String(i % 10)}℃`].join("\t"),
    ),
  ].join("\n"),
} as const;

/**
 * Stage 6: instructions for the poster. `promptMissingMask` and `promptMissingHours` carry no
 * poster tag, so they keep the previous candidate's type; `promptByType` carries no requirement.
 */
export const stage6Answers = {
  /** Picks a candidate that can pass and states both requirements. */
  promptOk: "ピクトグラムで、マスク着用と、面会時間は14時から16時までと入れて",
  promptMissingMask: "面会時間は14時から16時",
  promptMissingHours: "マスクも入れて",
  promptByType: {
    pictogram: "ピクトグラムで作って",
    multilingual: "多言語で作って",
    textheavy: "文章で丁寧に作って",
    default: "面会制限のポスターを作って",
  },
} as const satisfies {
  promptOk: string;
  promptMissingMask: string;
  promptMissingHours: string;
  promptByType: Readonly<Record<PosterTypeOf, string>>;
};
