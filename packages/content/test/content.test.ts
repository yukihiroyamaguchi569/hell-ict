import { access, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as content from "../src/index.js";
import {
  boardTileSchema,
  feverRowSchema,
  mailSchema,
  posterSchema,
  relayVoiceSchema,
  reportTokenSchema,
  sheetRowSchema,
  stageClearSchema,
  stage1MailSchema,
  viewerDocSchema,
} from "../src/schemas.js";

/**
 * 値の形（schema）と、値同士の取り決め（件数・参照の一致）を固定する。
 */

describe("Prologue", () => {
  it("受信トレイは3通で、どれも mailSchema を満たす", () => {
    expect(content.prologueMails).toHaveLength(3);
    for (const mail of content.prologueMails) expect(mailSchema.parse(mail)).toEqual(mail);
  });
});

describe("Stage 1", () => {
  const rounds = [content.stage1MailsRound1, content.stage1MailsRound2, content.stage1MailsRound3];

  it.each(rounds.map((round, index) => [index + 1, round] as const))(
    "R%iは5通で、どれも stage1MailSchema を満たす",
    (_round, mails) => {
      expect(mails).toHaveLength(5);
      for (const mail of mails) expect(stage1MailSchema.parse(mail)).toEqual(mail);
    },
  );

  it("メールの id は3ラウンドを通して重複しない（domain が id で着弾時刻を引くため）", () => {
    const ids = rounds.flatMap((round) => round.map((mail) => mail.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("R1 は全通が困惑（sad）を持ち、下書きを持たない", () => {
    for (const mail of content.stage1MailsRound1) {
      expect(mail.sad).toBeTruthy();
      expect(mail).not.toHaveProperty("draftPlain");
      expect(mail).not.toHaveProperty("draftCtx");
    }
  });

  it("R2・R3 は全通が2種の下書きを持ち、困惑を持たない", () => {
    for (const mail of [...content.stage1MailsRound2, ...content.stage1MailsRound3]) {
      expect(mail.draftPlain.length).toBeGreaterThan(0);
      expect(mail.draftCtx.length).toBeGreaterThan(0);
      expect(mail).not.toHaveProperty("sad");
    }
  });

  it("引き継ぎメモのコピー用テキストは本文の段落を改行1つで繋いだもの", () => {
    expect(mailSchema.parse(content.stage1Memo)).toEqual(content.stage1Memo);
    expect(content.stage1MemoText).toBe(content.stage1Memo.body.join("\n"));
    expect(content.stage1MemoText.split("\n")).toHaveLength(content.stage1Memo.body.length);
  });

  it("苅部さんの台詞は〔苅部〕の話者表記で始まる", () => {
    const lines = [
      ...content.stage1KarubeRound1Curt,
      ...content.stage1KarubeRound1Miss,
      ...content.stage1KarubeContext,
      ...content.stage1KarubeRound3Again.flat(),
      ...content.stage1KarubeRound3Hint,
      content.stage1KarubeManual,
    ];
    for (const line of lines) expect(line.startsWith("〔苅部〕")).toBe(true);
  });

  it("R3 の3回目からのヒント（#222）は既存の台詞と重ならない", () => {
    const existing = [...content.stage1KarubeContext, ...content.stage1KarubeRound3Again.flat()];
    for (const line of content.stage1KarubeRound3Hint) {
      expect(existing).not.toContain(line);
    }
  });

  it("R3 のやり直しの台詞は3回分で、回を追うごとに短くなる", () => {
    const lengths = content.stage1KarubeRound3Again.map((lines) => lines.join("").length);
    expect(lengths).toHaveLength(3);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe("Stage 2", () => {
  it("メール3通は mailSchema を満たし、依頼と追加分は添付を持つ", () => {
    for (const mail of [content.stage2Mail, content.stage2AddendumMail, content.stage2ClearMail]) {
      expect(mailSchema.parse(mail)).toEqual(mail);
    }
    expect(content.stage2Mail.attach).toBeTruthy();
    expect(content.stage2AddendumMail.attach).toBeTruthy();
  });

  it("ラインリストは6列で、配布版22行（ノイズ2行）・追加分10行", () => {
    for (const row of [...content.stage2SheetRows, ...content.stage2AddendumRows]) {
      expect(sheetRowSchema.parse(row)).toEqual(row);
    }
    const noise = content.stage2SheetRows.filter((row) =>
      row.slice(1).every((cell) => cell === ""),
    );
    expect(content.stage2SheetRows).toHaveLength(22);
    expect(noise).toHaveLength(2);
    expect(content.stage2AddendumRows).toHaveLength(10);
  });

  it("列見出しに氏名列は無い（Stage 4 の PII 検知に誤射されるため削除済み）", () => {
    expect(content.stage2Columns).not.toContain("氏名");
    expect(content.stage2Columns).toHaveLength(6);
  });

  it("設計用の注記（★印）を持ち込んでいない", () => {
    const text = JSON.stringify([content.stage2SheetRows, content.stage2AddendumRows]);
    expect(text).not.toContain("★");
    expect(content.stage2SheetText).not.toContain("★");
  });

  it("ビューアの本文は全行を含み、見出しは最初の実データ行の前に1回だけ入る", () => {
    const lines = content.stage2SheetText.split("\n");
    // 22行＋空行＋汚れた見出し行
    expect(lines).toHaveLength(content.stage2SheetRows.length + 2);
    expect(lines[0]).toBe(content.stage2SheetRows[0][0]);
    expect(lines[1]).toBe("");
    expect(lines[2]?.startsWith(content.stage2DirtyHeader[0])).toBe(true);
    for (const row of content.stage2SheetRows) {
      const [id] = row;
      if (id !== "") expect(content.stage2SheetText).toContain(id);
    }
  });

  describe("formatStage2Sheet", () => {
    // The dirty header line as the viewer shows it (the cells are content's, padded to width).
    const header = content.formatStage2Sheet([]).slice(1);

    it("空の表は空行と見出しだけを返し、見出しは汚れた見出しのセルを順に並べたもの", () => {
      expect(content.formatStage2Sheet([])).toBe(`\n${header}`);
      expect(header.split(/\s+/u)).toEqual([...content.stage2DirtyHeader]);
    });

    it("ノイズ行だけの表は、末尾に見出しを付ける", () => {
      expect(content.formatStage2Sheet([["タイトル", "", "", "", "", ""]])).toBe(
        `タイトル\n\n${header}`,
      );
    });

    it("全角は2セル分として桁を揃え、幅を超える値にも1つは空白を挟む", () => {
      expect(content.formatStage2Sheet([["００１", "5A", "7/3", "陽性", "あり", "備考"]])).toBe(
        `\n${header}\n００１    5A          7/3          陽性   あり     備考`,
      );
      expect(content.formatStage2Sheet([["12345678901", "", "7/3", "", "", ""]])).toBe(
        `\n${header}\n12345678901             7/3`,
      );
    });
  });
});

describe("Stage 3", () => {
  it("メール3通は mailSchema を満たし、カワイさんと師長は添付を持つ", () => {
    for (const mail of [content.stage3LabMail, content.stage3KawaiMail, content.stage3ShichoMail]) {
      expect(mailSchema.parse(mail)).toEqual(mail);
    }
    expect(content.stage3LabMail).not.toHaveProperty("attach");
    expect(content.stage3KawaiMail.attach).toBeTruthy();
    expect(content.stage3ShichoMail.attach).toBeTruthy();
  });

  it("肖像つきの台詞（看護部長・皮膚科医）は話者表記〔〕を持たず、苅部さんは持つ", () => {
    for (const line of [...content.stage3NoticeLines, ...content.stage3TrapDoctorLines]) {
      expect(line.startsWith("〔")).toBe(false);
    }
    for (const line of [...content.stage3KarubeLines, content.stage3KarubeAfterTrap]) {
      expect(line.startsWith("〔苅部〕")).toBe(true);
    }
  });

  // The hints point at the manual and give no answer: pasted into a field, they satisfy none of
  // its required words and trip no trap word (the words live in stage3Rules).
  it.each([
    ["罠が続いたときの苅部さん（#219）", content.stage3KarubeTypeHint],
    ["4回目のだめ押し（#219）", content.stage3KarubeFinalPush],
  ] as const)("%sは〔苅部〕の台詞で、判定の必要語を揃えず罠語にも当たらない", (_name, lines) => {
    for (const line of lines) expect(line.startsWith("〔苅部〕")).toBe(true);
    const text = lines.join("");
    for (const field of content.stage3FieldIds) {
      expect(content.stage3Rules.required[field].every((re) => re.test(text))).toBe(false);
      expect(content.stage3Rules.traps[field].words.test(text)).toBe(false);
    }
  });

  it("病型を問うヒントは、判定の必要語を一つも含まない", () => {
    const text = content.stage3KarubeTypeHint.join("");
    for (const field of content.stage3FieldIds) {
      for (const re of content.stage3Rules.required[field]) expect(re.test(text)).toBe(false);
    }
  });

  it("だめ押しが名指す節は、アプリ内マニュアルの節番号・見出しと一字一句同じ", () => {
    const quoted = [...content.stage3KarubeFinalPush.join("").matchAll(/「([^」]+)」/g)].map(
      (match) => match[1],
    );
    expect(quoted.length).toBeGreaterThan(0);
    // The viewer's heading lines, without their page mark (p.NN).
    const headings = content.stage3ManualText
      .split("\n")
      .map((line) => /^(５-\S+\s.+?)（p\.\d+）$/.exec(line)?.[1])
      .filter((heading) => heading !== undefined);
    for (const heading of quoted) expect(headings).toContain(heading);
  });

  it("早見表は5項目（全角空白1つで始まる行）で、台本の罠応答は4行", () => {
    const items = content.stage3ContaminatedText
      .split("\n")
      .filter((line) => /^\u3000[^\u3000]/u.test(line));
    expect(items).toHaveLength(5);
    expect(content.stage3TrapLie).toHaveLength(4);
  });

  it("提出欄の名前は3欄ぶん", () => {
    expect(Object.keys(content.stage3FieldLabels).sort()).toEqual(["clean", "ppe", "release"]);
  });
});

describe("Stage 4", () => {
  it("院長の開始演出は2画面で、肖像つきなので話者表記を持たない", () => {
    expect(content.stage4DirectorPages).toHaveLength(2);
    for (const line of content.stage4DirectorPages.flat())
      expect(line.startsWith("〔")).toBe(false);
  });

  it("台本モードの要約は7行", () => {
    expect(content.stage4ScriptedSummary).toHaveLength(7);
  });

  it("院長の問いと差し戻しは〔院長〕の話者表記で始まる", () => {
    const lines = [
      ...content.stage4QuestionLines,
      content.stage4SummaryReject,
      ...Object.values(content.stage4ActionRejects),
    ];
    for (const line of lines) expect(line.startsWith("〔院長〕")).toBe(true);
  });

  // The reject lines give neither what to ask nor whom (#220). Only the one for patients reports
  // the result about the symptom, so it may name it; it still names no target.
  it.each(["missing-what", "missing-whom", "missing-both"] as const)(
    "行動提案の差し戻し %s は、判定の内容語にも対象語にも当たらない",
    (reason) => {
      const text = content.stage4ActionRejects[reason];
      expect(content.stage4Rules.actionContent.test(text)).toBe(false);
      expect(content.stage4Rules.actionTarget.test(text)).toBe(false);
    },
  );

  it("患者向けの差し戻しも対象語を言わない", () => {
    const text = content.stage4ActionRejects["aimed-at-patients"];
    expect(content.stage4Rules.actionTarget.test(text)).toBe(false);
  });

  // Pasting the screen's lines or the report must not pass the summary judge.
  it("院長の台詞・転送メール・論文は要約の判定（stage4Rules.summary）に当たらない", () => {
    const texts = [
      content.stage4DirectorPages.flat().join(""),
      content.stage4DirectorMail.body.join(""),
      content.stage4ReportText,
    ];
    for (const text of texts) expect(content.stage4Rules.summary.test(text)).toBe(false);
    expect(mailSchema.parse(content.stage4DirectorMail)).toEqual(content.stage4DirectorMail);
  });
});

describe("Stage 5", () => {
  it("発熱患者一覧は14名で、どの行も feverRowSchema を満たし、患者IDは重複しない", () => {
    for (const row of content.stage5FeverRows) expect(feverRowSchema.parse(row)).toEqual(row);
    const ids = content.stage5FeverRows.map((row) => row.id);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
  });

  it("列選択コピーの表は見出し6列と14行で、行は一覧の値を列の順に並べたもの", () => {
    const { header, rows } = content.stage5FeverTable;
    expect(header).toEqual(["患者ID", "氏名", "病棟", "発熱確認日", "最高体温", "備考"]);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual(Object.values(content.stage5FeverRows[0]));
  });

  it("ビューアの一覧は見出し行つきのタブ区切りで、空欄のセルも列数を保つ", () => {
    const lines = content.stage5FeverSheetText.split("\n");
    expect(lines).toHaveLength(15);
    for (const line of lines) expect(line.split("\t")).toHaveLength(6);
  });

  it("黒塗りの報告書の片はどれも reportTokenSchema を満たし、塗るべき語が20個ある", () => {
    for (const token of content.stage5IncidentReport) {
      expect(reportTokenSchema.parse(token)).toEqual(token);
    }
    expect(content.stage5IncidentReport.filter((token) => token.pii === true)).toHaveLength(20);
    expect(content.stage5IncidentReport.some((token) => token.pii === false)).toBe(true);
  });

  it("報告書の連絡先は実在しない値だけ（example.com・局番0000）", () => {
    const text = content.stage5IncidentReport.map((token) => token.t).join("");
    for (const mail of text.match(/[\w.]+@[\w.]+/gu) ?? [])
      expect(mail.endsWith("@example.com")).toBe(true);
    for (const tel of text.match(/0\d{2}-\d{4}-\d{4}/gu) ?? [])
      expect(tel.startsWith("090-0000-")).toBe(true);
  });

  it("書式の差し戻しは3種", () => {
    expect(Object.keys(content.stage5FormatRejects).sort()).toEqual(["date", "fullwidth", "temp"]);
  });

  describe("差し戻しの行（#221: 理由をまとめて示す）", () => {
    const lines = content.stage5SubmissionRejectLines;

    it.each(["fullwidth", "date", "temp"] as const)(
      "書式の理由が%sだけなら、モックと同じ1文",
      (reason) => {
        expect(lines([{ reason }])).toEqual([content.stage5FormatRejects[reason]]);
      },
    );

    it("IDの不足だけなら、不足の人数とIDを並び順のまま示す", () => {
      expect(lines([{ reason: "ids", missingIds: ["002", "030"] }])).toEqual([
        "あと2名分足りないようです（不足ID：002・030）。",
      ]);
    });

    it("書式の理由が2つ以上なら、前置きに件数を添えて箇条書きで並べる", () => {
      expect(lines([{ reason: "fullwidth" }, { reason: "date" }, { reason: "temp" }])).toEqual([
        "保健所に出す書式になっていません。直すところが3つあります。",
        "・全角の数字が残っています。",
        "・日付の書き方を1種類に揃えてください。",
        "・体温の単位の付け方を揃えてください。",
      ]);
    });

    it("IDの不足と書式の理由1つなら、不足の行の後にモックと同じ1文", () => {
      expect(lines([{ reason: "ids", missingIds: ["030"] }, { reason: "temp" }])).toEqual([
        "あと1名分足りないようです（不足ID：030）。",
        content.stage5FormatRejects.temp,
      ]);
    });

    it("4種類すべてなら、不足の行の後に書式の3件を箇条書き", () => {
      expect(
        lines([
          { reason: "ids", missingIds: ["030"] },
          { reason: "fullwidth" },
          { reason: "date" },
          { reason: "temp" },
        ]),
      ).toEqual([
        "あと1名分足りないようです（不足ID：030）。",
        "保健所に出す書式になっていません。直すところが3つあります。",
        "・全角の数字が残っています。",
        "・日付の書き方を1種類に揃えてください。",
        "・体温の単位の付け方を揃えてください。",
      ]);
    });

    it("理由が無ければ行も無い", () => {
      expect(lines([])).toEqual([]);
    });
  });
});

describe("Stage 6", () => {
  it("メール2通は mailSchema を満たし、近藤さんのメールだけが添付を持つ", () => {
    for (const mail of [content.stage6JimuMail, content.stage6SoudanMail]) {
      expect(mailSchema.parse(mail)).toEqual(mail);
    }
    expect(content.stage6JimuMail).not.toHaveProperty("attach");
    expect(content.stage6SoudanMail.attach).toBeTruthy();
  });

  it("以前の掲示物（悪い実例）は番号つきの6項目", () => {
    expect(content.stage6NoticeOldText.match(/^\d+\. /gmu)).toHaveLength(6);
  });

  it("候補画像は種類が重複せず、既定の候補を含めて4種", () => {
    const posters = [...content.stage6Posters, content.stage6PosterDefault];
    for (const poster of posters) expect(posterSchema.parse(poster)).toEqual(poster);
    expect(new Set(posters.map((poster) => poster.type)).size).toBe(4);
    expect(content.stage6PosterDefault.type).toBe("default");
  });

  it.each([...content.stage6Posters, content.stage6PosterDefault].map((poster) => poster.img))(
    "候補画像 %s は assets/images/production/ にある",
    async (name) => {
      const path = new URL(`../../../assets/images/production/${name}`, import.meta.url);
      await expect(access(path)).resolves.toBeUndefined();
    },
  );

  it("候補の種類による差し戻しは、無条件で差し戻す2種（文章中心・既定）ぶん", () => {
    expect(Object.keys(content.stage6RejectType).sort()).toEqual(["default", "textheavy"]);
  });

  it("近藤さんの差し戻しは〔近藤〕、苅部さんは〔苅部〕の話者表記で始まる", () => {
    const kondo = [
      ...Object.values(content.stage6RejectType),
      ...Object.values(content.stage6RequirementRejects),
    ];
    for (const line of kondo) expect(line.startsWith("〔近藤〕")).toBe(true);
    expect(content.stage6KarubeLine.startsWith("〔苅部〕")).toBe(true);
  });
});

describe("Final・エピローグ", () => {
  it("メール2通は mailSchema を満たし、広報課のメールだけが添付を持つ", () => {
    for (const mail of [content.finalJimuMail, content.finalKohoMail]) {
      expect(mailSchema.parse(mail)).toEqual(mail);
    }
    expect(content.finalJimuMail).not.toHaveProperty("attach");
    expect(content.finalKohoMail.attach).toBeTruthy();
  });

  it("追加質問の件数はエピローグの台詞と広報課のメールで一致する", () => {
    const count = /\d+件/u.exec(content.finalKohoMail.subj)?.[0];
    expect(count).toBeDefined();
    expect(content.epilogueLines.join("")).toContain(count);
    expect(content.finalKohoMail.body.join("")).toContain(count);
  });

  it("振り返りボードは Stage 1〜6 の6枚", () => {
    for (const tile of content.finalBoardTiles) expect(boardTileSchema.parse(tile)).toEqual(tile);
    expect(content.finalBoardTiles.map((tile) => tile.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ]);
  });

  it("労いリレーは院長→看護部長→事務長の順", () => {
    for (const voice of content.finalRelay) expect(relayVoiceSchema.parse(voice)).toEqual(voice);
    expect(content.finalRelay.map((voice) => voice.name)).toEqual(["院長", "看護部長", "事務長"]);
  });
});

describe("ステージ横断の演出", () => {
  it("クリアの演出は Stage 1〜6 のぶんあり、どれも stageClearSchema を満たす", () => {
    expect(Object.keys(content.stageClears)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    for (const clear of Object.values(content.stageClears)) {
      expect(stageClearSchema.parse(clear)).toEqual(clear);
    }
  });

  it("クリアの全画面の絵は②③の12枚すべて別の画像", () => {
    const imgs = Object.values(content.stageClears).flatMap((clear) => [
      clear.field.fullscreen.img,
      clear.execFullscreen.img,
    ]);
    expect(imgs).toHaveLength(12);
    expect(new Set(imgs).size).toBe(12);
  });

  it.each(
    Object.values(content.stageClears).flatMap((clear) => [
      clear.field.fullscreen.img,
      clear.execFullscreen.img,
    ]),
  )("クリアの全画面の絵 %s は assets/images/production/ にある", async (name) => {
    const path = new URL(`../../../assets/images/production/${name}`, import.meta.url);
    await expect(access(path)).resolves.toBeUndefined();
  });

  it("現場の反応は Stage 1 だけ3行、ほかは1行", () => {
    const counts = Object.values(content.fieldEchoes).map((echo) => echo.lines.length);
    expect(counts).toEqual([3, 1, 1, 1, 1, 1]);
  });

  it("肖像つきの台詞（現場・幹部）は話者表記〔〕を持たない", () => {
    for (const clear of Object.values(content.stageClears)) {
      for (const line of [...clear.field.lines, ...clear.exec])
        expect(line.startsWith("〔")).toBe(false);
    }
  });

  it("クリアの副題に罠の名前を書かない", () => {
    for (const clear of Object.values(content.stageClears)) {
      expect(clear.sub).not.toMatch(/嘘|ハルシネーション|情報漏洩|罠/u);
    }
  });

  it("Stage 1 だけ副題と効果音を持たない（急変の一報と結果ウィンドウの音に譲る）", () => {
    expect(content.stageClears.s1.sub).toBe("");
    expect(content.stageClears.s1.sfx).toBe("");
    for (const stage of ["s2", "s3", "s4", "s5", "s6"] as const) {
      expect(content.stageClears[stage].sfx).toBe("success1");
    }
  });

  it("操作担当の交代の案内は Stage 2 と Stage 4 の2か所だけで、どちらも交代の一文から始まる", () => {
    expect(Object.keys(content.handoverNotes)).toEqual(["s2", "s4"]);
    for (const lines of Object.values(content.handoverNotes)) {
      expect(lines[0]).toBe(content.handoverSwapLine);
    }
  });

  it("院内連絡先の待ち文言は苅部さんの台詞", () => {
    expect(content.phsBusyLine.startsWith("〔苅部〕")).toBe(true);
    expect(content.aiGreetingText).toBeTruthy();
  });
});

describe("ビューア", () => {
  it("すべての文書が viewerDocSchema を満たす", () => {
    for (const doc of Object.values(content.viewerDocs)) {
      expect(viewerDocSchema.parse(doc)).toEqual(doc);
    }
  });

  it("引き継ぎメモの控えは受信トレイの［本文をコピー］と同じ文字列", () => {
    expect(content.viewerDocs.s1memo.text).toBe(content.stage1MemoText);
  });
});

describe("読み込み画面（Issue #379）", () => {
  const productionDir = new URL("../../../assets/images/production/", import.meta.url);

  /** content のどこかに書かれた画像のファイル名（`img` などの値）を、入れ子をたどって集める。 */
  const referencedImages = (value: unknown): string[] => {
    if (typeof value === "string") return /^[\w-]+\.(?:png|webp|svg)$/u.test(value) ? [value] : [];
    if (typeof value !== "object" || value === null) return [];
    return Object.values(value).flatMap(referencedImages);
  };

  it("先読みの一覧は assets/images/production/ の画像ファイルと過不足なく一致する", async () => {
    const files = (await readdir(productionDir)).filter((name) =>
      /\.(?:png|webp|svg|jpe?g|gif|avif)$/u.test(name),
    );
    expect([...content.productionImages].sort()).toEqual(files.sort());
  });

  it("先読みの一覧に重複が無い", () => {
    expect(new Set(content.productionImages).size).toBe(content.productionImages.length);
  });

  it("content が参照する画像はすべて先読みの一覧に入っている", () => {
    const { productionImages, ...rest } = content;
    const listed: ReadonlySet<string> = new Set(productionImages);
    const referenced = referencedImages(rest);
    expect(referenced.length).toBeGreaterThan(20);
    expect(referenced.filter((name) => !listed.has(name))).toEqual([]);
  });

  it("背景の画像は production にあり、先読みの一覧にも入っている", async () => {
    await expect(access(new URL(content.opening.img, productionDir))).resolves.toBeUndefined();
    expect(content.productionImages).toContain(content.opening.img);
  });
});

describe("ステージをまたぐ整合", () => {
  /** Every string in a value, with the path it sits at. */
  const stringsIn = (value: unknown, path: string): [string, string][] => {
    if (typeof value === "string") return [[path, value]];
    if (Array.isArray(value)) return value.flatMap((item, i) => stringsIn(item, `${path}[${i}]`));
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, item]) => stringsIn(item, `${path}.${key}`));
    }
    return [];
  };

  /** The fever list itself, its views, and the incident report about it. */
  const allowed = [
    "stage5FeverRows",
    "stage5FeverTable",
    "stage5FeverSheetText",
    "stage5IncidentReport",
    "viewerDocs.s5list",
  ];

  it("発熱患者の氏名は、発熱患者一覧と報告書のほかの文章に出ない（空白の有無を問わない）", () => {
    const names = content.stage5FeverRows.flatMap(({ name }) => [name, name.replace(/\s/gu, "")]);
    const leaks = stringsIn(content, "")
      .filter(([path]) => !allowed.some((prefix) => path.startsWith(`.${prefix}`)))
      .filter(([, text]) => names.some((name) => text.includes(name)))
      .map(([path]) => path);
    expect(leaks).toEqual([]);
  });

  it("許す場所の一覧は、実際に氏名を持つ（一覧が古びていない）", () => {
    const names = content.stage5FeverRows.map(({ name }) => name);
    for (const prefix of allowed) {
      const texts = stringsIn(content, "")
        .filter(([path]) => path.startsWith(`.${prefix}`))
        .map(([, text]) => text);
      expect(
        texts.some((text) => names.some((name) => text.includes(name))),
        prefix,
      ).toBe(true);
    }
  });
});
