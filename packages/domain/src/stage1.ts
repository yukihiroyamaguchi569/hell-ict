import type { Stage1EmailId, Stage1Reply } from "./schemas/team-state.js";

export interface Stage1Email {
  readonly id: Stage1EmailId;
  readonly from: string;
  readonly subject: string;
  readonly body: readonly string[];
  readonly arrivalOffsetMs: number;
}

/** 着弾から返信できなくなるまでの猶予（docs/scenario/02_Stage1_平常運転.md §ルール）。 */
export const STAGE1_ROUND1_DEADLINE_MS = 60_000;

/** 25字は実文例で較正した値（docs/ui/mock/index.html S1_MIN_LEN と同じ）。 */
export const STAGE1_MIN_REPLY_LENGTH = 25;

export const STAGE1_POLITE_PATTERN = /(ます|ください|いたし|ございま|よろしく|お願い|存じ)/;

/**
 * 1回目・10通。すべて平時の事務連絡で、緊急のものは1通もない。
 * 文面とタイミングは docs/ui/mock/index.html の S1_MAILS_R1 をそのまま移植する。
 */
export const STAGE1_ROUND1_EMAILS: readonly Stage1Email[] = [
  {
    id: "m1",
    arrivalOffsetMs: 0,
    from: "3B病棟 看護師",
    subject: "サージカルマスクの在庫について",
    body: [
      "いつもお世話になっております。",
      "3Bのマスク在庫が残り少ないのですが、追加はどちらに申請すればよいでしょうか。",
      "お手すきの際にご返信いただければ助かります。",
    ],
  },
  {
    id: "m2",
    arrivalOffsetMs: 4_000,
    from: "人事課",
    subject: "先月の研修、出席されていますか",
    body: [
      "標記の件、着任されたばかりの皆様のお名前が出席簿に見当たりません。",
      "出席・欠席の別をご確認のうえご返信ください。",
    ],
  },
  {
    id: "m3",
    arrivalOffsetMs: 8_000,
    from: "医療安全管理室",
    subject: "今年度のICT委員会、日程を決めたいのですが",
    body: [
      "前任の方と調整中だった委員会の日程が宙に浮いております。",
      "第3水曜の午後で固定してよろしいか、ご意向を伺えますか。",
    ],
  },
  {
    id: "m4",
    arrivalOffsetMs: 13_000,
    from: "薬剤部",
    subject: "抗菌薬使用量の集計、様式が変わりました",
    body: [
      "今年度から集計様式が変更になっております。",
      "新しい様式でよろしいか、念のためご確認をお願いします。",
    ],
  },
  {
    id: "m5",
    arrivalOffsetMs: 18_000,
    from: "総務課",
    subject: "名札の発注、サイズはどちらにしますか",
    body: [
      "派遣スタッフの皆様の名札を発注いたします。",
      "大小2種類ございますので、ご希望をお知らせください。",
    ],
  },
  {
    id: "m6",
    arrivalOffsetMs: 23_000,
    from: "教育担当",
    subject: "来月の実習生受け入れ、対応可能ですか",
    body: [
      "看護学生の実習で、感染対策の講義を1コマお願いしたいと考えております。",
      "対応可能かどうかだけ、先にお返事いただけますか。",
    ],
  },
  {
    id: "m7",
    arrivalOffsetMs: 29_000,
    from: "事務当直",
    subject: "メーリングリストへの登録をお願いします",
    body: [
      "ICT宛の連絡用メーリングリストに、新しい皆様を登録いたします。",
      "登録するアドレスをご返信ください。",
    ],
  },
  {
    // 未知ウイルスの種（docs/scenario/00_未知ウイルスの通奏低音.md §3）。
    // 業務連絡の3行目に埋め、太字にも色付けにもしない。
    id: "m8",
    arrivalOffsetMs: 35_000,
    from: "検査科",
    subject: "月次の細菌検査報告書、送付先を教えてください",
    body: [
      "先月分の報告書ができあがりました。",
      "前任の方には紙でお渡ししていましたが、いかがいたしますか。",
      "なお、今月は培養提出が少し増えております。集計に含めてよいか、併せてご確認ください。",
    ],
  },
  {
    id: "m9",
    arrivalOffsetMs: 41_000,
    from: "3B病棟 看護師",
    subject: "手指消毒の残量チェック表、誰が回収しますか",
    body: [
      "毎月つけているチェック表ですが、回収の担当が分からなくなっています。",
      "病棟で保管でよいのか、ICTへお渡しするのか教えてください。",
    ],
  },
  {
    id: "m10",
    arrivalOffsetMs: 47_000,
    from: "前任ICN",
    subject: "引き継ぎ、大丈夫そうですか",
    body: [
      "急に辞めることになってしまってすみません。",
      "何か分からないことがあれば遠慮なく聞いてください。",
    ],
  },
];

/** 内容の正しさは判定しない。長さと丁寧さだけで通す（docs/scenario/02_Stage1_平常運転.md §返信の判定）。 */
export const judgeStage1Reply = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.length >= STAGE1_MIN_REPLY_LENGTH && STAGE1_POLITE_PATTERN.test(trimmed);
};

export type Stage1EmailStatus = "pending" | "replied" | "expired";

export const stage1EmailStatus = (
  email: Stage1Email,
  replies: readonly Stage1Reply[],
  roundStartedAt: string,
  now: Date,
): Stage1EmailStatus => {
  if (replies.some((reply) => reply.emailId === email.id)) return "replied";
  const deadline =
    new Date(roundStartedAt).getTime() + email.arrivalOffsetMs + STAGE1_ROUND1_DEADLINE_MS;
  return now.getTime() >= deadline ? "expired" : "pending";
};

export const isStage1Round1Complete = (
  replies: readonly Stage1Reply[],
  roundStartedAt: string,
  now: Date,
): boolean =>
  STAGE1_ROUND1_EMAILS.every(
    (email) => stage1EmailStatus(email, replies, roundStartedAt, now) !== "pending",
  );

export interface Stage1Round1Tally {
  readonly repliedCount: number;
  readonly curtCount: number;
}

/** 処理結果ウィンドウの表示に使う集計（docs/scenario/02_Stage1_平常運転.md §処理結果のウィンドウ）。 */
export const stage1Round1Tally = (replies: readonly Stage1Reply[]): Stage1Round1Tally => ({
  repliedCount: replies.length,
  curtCount: replies.filter((reply) => !reply.polite).length,
});
