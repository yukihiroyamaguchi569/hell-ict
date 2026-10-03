import { stage5FeverRows } from "@hell-ict/content";
import { stage5Answers } from "@hell-ict/content/answers";

/*
 * PII 検知のテストに使う氏名。シナリオ（content）の発熱患者から取り、本番の氏名を直書きしない。
 * 姓と名は半角空白で区切られている前提で、書き方の揺れ（詰める・改行する）もここで作る。
 */

/** The surname; a name without the space between surname and given name is a broken scenario. */
export const surnameOf = (name: string): string => {
  const [surname, given] = name.split(" ");
  if (surname === undefined || surname === "" || given === undefined || given === "") {
    throw new Error(`姓と名を半角空白で区切っていない氏名: ${name}`);
  }
  return surname;
};

/** 一覧の先頭の患者（カルテの患者）。 */
export const PII_NAME = stage5Answers.piiName;
export const PII_SURNAME = surnameOf(PII_NAME);
export const PII_NAME_JOINED = PII_NAME.replace(" ", "");
export const PII_NAME_BROKEN = PII_NAME.replace(" ", "\n");

/** 先頭以外の患者も検知されることを見るための、2行目と最終行の患者。 */
export const [, SECOND_PATIENT] = stage5FeverRows;
export const SECOND_SURNAME = surnameOf(SECOND_PATIENT.name);
export const SECOND_NAME_JOINED = SECOND_PATIENT.name.replace(" ", "");
export const LAST_PATIENT_NAME = stage5FeverRows[stage5FeverRows.length - 1]?.name ?? "";
