import { createServer } from "node:http";

/**
 * OpenAI Chat Completions APIの最小スタブ。E2Eでは実キーを使わず、
 * wrangler devへ `--var OPENAI_BASE_URL:http://127.0.0.1:<port>` で
 * このサーバーを指させる（本番コードに分岐を足さず、設定値だけを差し替える）。
 */
const port = Number(process.env.OPENAI_STUB_PORT ?? "8789");

/** 既定の応答。Stage 5 の整形依頼以外は、中身を読まずこれを返す。 */
const DEFAULT_REPLY = "（スタブ応答）承知しました。";

/* ---------------------------------------------------------------------- *
 * Stage 5（報告）の整形応答                                                *
 *                                                                        *
 * モックの台本応答（s5ScriptedTable）は台本モード専用の分岐で、LIVEでは    *
 * 通らない。LIVEのStage 5をE2Eで通すには、実モデルが返すはずの「氏名列を   *
 * 落とし、日付をISO1種類・体温を℃へ揃えたタブ区切りの表」をスタブが返す    *
 * 必要がある。ただし14名分の値をここへ持たない——送られてきた本文の見出し  *
 * 行と行データだけから組み立てる（教材の写しを増やすと、モック・教材・     *
 * スタブの三重管理になって片方だけ直り静かに壊れる）。                     *
 * ---------------------------------------------------------------------- */

/**
 * Stage 5 の依頼語。モックの S5_REQUEST_TRIGGER と同じ語彙にする——
 * 「表の形をしている」だけで発火させると、別ステージでたまたま表を貼った
 * 送信まで整形応答へ流れてしまう。
 */
const REQUEST_TRIGGER = /整形|整えて|一覧|まとめて|表にして|並べて/;

/** 表の区切り。タブ、または2つ以上連続する空白。 */
const FIELD_SEP = /\t|[ \u3000]{2,}/;
/** 見出し行の目印。列選択コピー（#viewer-cols）は必ず見出し行を含む。 */
const ID_HEADER = "患者ID";
const DATE_HEADER = "発熱確認日";
const TEMP_HEADER = "最高体温";

/** 全角の数字と記号を半角へ（℃は全角英数の範囲外なので残る）。 */
const toHalfWidth = (value) =>
  value.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * 教材に混ざる12通りの日付表記をISO（YYYY-MM-DD）へ寄せる。
 * R8＝令和8年＝2026年、年の無い表記も2026年として扱う。読めない値は素通しする
 * （実モデルも読めないものを勝手に捏造はしない、という建て付け）。
 */
const toIsoDate = (raw) => {
  const matched = toHalfWidth(raw)
    .trim()
    .match(/^(?:(\d{4})[-/年]|R(\d{1,2})[./])?(\d{1,2})[-./月](\d{1,2})日?$/);
  if (!matched) return raw;
  const year = matched[1] ? Number(matched[1]) : matched[2] ? 2018 + Number(matched[2]) : 2026;
  return `${String(year)}-${matched[3].padStart(2, "0")}-${matched[4].padStart(2, "0")}`;
};

/** 体温は全角を直し、値があるものだけ℃を付け直す（空欄はそのまま空欄）。 */
const toCelsius = (raw) => {
  const value = toHalfWidth(raw).replace(/℃/g, "").trim();
  return value ? `${value}℃` : "";
};

/** 1行を列へ割る。前後の空白は落とし、空行は空配列にする。 */
const splitFields = (line) =>
  line.trim() === "" ? [] : line.split(FIELD_SEP).map((field) => field.trim());

/**
 * 発熱患者一覧の整形。①Stage 5 の依頼語があり ②見出し行に患者ID・
 * 発熱確認日・最高体温の3列が揃い ③データ行が2行以上ある——を全部満たす
 * ときだけ、日付と体温を揃えたタブ区切りの表を返す。ひとつでも欠ければnull
 * （＝既定の固定文へ落ちる）。
 */
const formatFeverLinelist = (text) => {
  if (!REQUEST_TRIGGER.test(text)) return null;
  const lines = text.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.includes(ID_HEADER) && splitFields(line).length >= 2,
  );
  if (headerIndex < 0) return null;
  const header = splitFields(lines[headerIndex]);
  const dateColumn = header.indexOf(DATE_HEADER);
  const tempColumn = header.indexOf(TEMP_HEADER);
  // 整形する列そのものが無い表は、この一覧ではない。
  if (dateColumn < 0 || tempColumn < 0) return null;

  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const fields = splitFields(line);
    if (fields.length < 2) break; // 表が途切れたら、そこから先は添え書き
    rows.push(
      fields.map((field, index) =>
        index === dateColumn ? toIsoDate(field) : index === tempColumn ? toCelsius(field) : field,
      ),
    );
  }
  if (rows.length < 2) return null;

  const table = [header, ...rows].map((row) => row.join("\t")).join("\n");
  return `承知しました。日付はYYYY-MM-DD、体温は℃に統一しました。\n\n${table}`;
};

/* ---------------------------------------------------------------------- *
 * Stage 1（平常運転）の返信下書き                                          *
 *                                                                        *
 * 既定の固定文（DEFAULT_REPLY）は14文字しかなく、モックの返信判定           *
 * （S1_MIN_LEN＝70文字以上 かつ S1_POLITE の丁寧語を含む）に届かない。      *
 * そのためLIVEで［AIに下書きさせる］を使うと、下書きをそのまま送っても必ず  *
 * 「そっけない」判定になり、Stage 1 をクリアできない——当日と同じLIVE経路を  *
 * スタブで通せない、という形で塞がっていた。                               *
 *                                                                        *
 * 直すのはスタブだけで、モック側の判定（S1_MIN_LEN / S1_POLITE）は動かさない。*
 * 実モデルはこの程度の長さの丁寧な下書きを返すので、スタブが短すぎるほうが  *
 * 実態から外れている。                                                     *
 * ---------------------------------------------------------------------- */

/**
 * Stage 1 の下書き依頼の目印。モックの s1BuildDraftText が必ず先頭へ置く
 * 固定文と、受信メールのブロック見出しの両方を求める。参加者が打つ自由文では
 * まず書かない組み合わせなので、Stage 2〜5 のチャットへ紛れ込まない。
 */
const S1_DRAFT_HEAD = "次の院内メールへの返信を下書きしてください。";
const S1_MAIL_BLOCK = "【受信メール】";
/** 下書き依頼に含まれる差出人。宛名に使う（無ければ宛名を省く）。 */
const S1_FROM = /^差出人:\s*(.+)$/m;

/**
 * Stage 1 の返信下書き。S1_MIN_LEN（70文字）とS1_POLITE（丁寧語）を必ず満たす
 * 長さと文面にする。内容は「確認して折り返す」だけ——この世界に正しい答えは
 * 存在しない（架空の病院なので実モデルも知らない）ので、院内固有の連絡先や
 * 数値を作り話で埋めない。モックの draftPlain と同じ建て付け。
 */
const draftStage1Reply = (text) => {
  if (!text.includes(S1_DRAFT_HEAD) || !text.includes(S1_MAIL_BLOCK)) return null;
  const matched = S1_FROM.exec(text);
  const salutation = matched === null ? "" : `${matched[1].trim()} 各位\n`;
  return (
    "（スタブ応答）\n" +
    salutation +
    "お世話になっております。ご連絡いただきありがとうございます。\n" +
    "いただいた件につきましては、こちらで確認のうえ、改めてご連絡いたします。\n" +
    "お手数をおかけいたしますが、よろしくお願いいたします。"
  );
};

/** 会話履歴からユーザー発言だけを繋ぐ（systemの指示文を表と読み違えないため）。 */
const userText = (payload) => {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages
    .filter((message) => message?.role === "user" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");
};

const replyFor = (body) => {
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    return DEFAULT_REPLY;
  }
  // Stage 5 の整形を先に見る（この分岐は患者ID・発熱確認日・最高体温の見出しと
  // データ2行以上を求めるので、Stage 1 の下書き依頼が紛れ込むことはない）。
  // 続いて Stage 1 の下書き。どちらでもなければ従来どおり固定文へ落ちる。
  const text = userText(payload);
  return formatFeverLinelist(text) ?? draftStage1Reply(text) ?? DEFAULT_REPLY;
};

/* ---------------------------------------------------------------------- *
 * 受信本文の記録（GET /seen?q=... で件数を返す）                           *
 *                                                                        *
 * 「送信前ゲートで止めた本文はOpenAIへ一度も届いていない」ことをE2Eから    *
 * 確かめるための窓口。テストは並列に走るので通し回数では判定できない——     *
 * そのテストだけが送る印を問い合わせる形にする。                           *
 * ---------------------------------------------------------------------- */
const SEEN_LIMIT = 200;
const seen = [];

const rememberRequest = (body) => {
  seen.push(body);
  if (seen.length > SEEN_LIMIT) seen.shift();
};

const respondJson = (response, payload) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

/** GETの経路。扱えたらtrueを返す。 */
const handleGet = (url, response) => {
  if (url.pathname === "/health") {
    response.writeHead(200).end("ok");
    return true;
  }
  if (url.pathname === "/seen") {
    const query = url.searchParams.get("q") ?? "";
    respondJson(response, {
      count: query === "" ? 0 : seen.filter((body) => body.includes(query)).length,
    });
    return true;
  }
  return false;
};

const handleCompletion = (request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    rememberRequest(body);
    respondJson(response, {
      choices: [{ message: { content: replyFor(body) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
  if (request.method === "GET" && handleGet(url, response)) return;
  if (request.method === "POST" && url.pathname === "/chat/completions") {
    handleCompletion(request, response);
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`openai-stub listening on http://127.0.0.1:${String(port)}\n`);
});
