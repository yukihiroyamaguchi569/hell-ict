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
  return formatFeverLinelist(userText(payload)) ?? DEFAULT_REPLY;
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
