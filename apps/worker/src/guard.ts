import { teamCodeSchema } from "@hell-ict/domain";
import { z } from "zod";

/**
 * 公開Worker APIの入口ガード（Origin検証・チームコードの規則判定・チーム単位の
 * レート制限）。判定はすべて副作用のないPure Functionとして置き、index.tsの
 * fetch入口とTeamRoomからは「決めた結果」だけを使う。
 *
 * 前提: 本番（2026年9月の集合研修）はモックHTMLをWorkerのAssetsから配信するため、
 * ブラウザとAPIは同一オリジンになる。ALLOWED_ORIGINSを設定しなくても動くのが
 * 既定の状態で、別オリジン配信や開発時の別ポートだけが明示設定を要する。
 *
 * Origin検証は認証ではない。Originヘッダーもそれが無いことも、非ブラウザの
 * クライアント（curl、スクリプト）は自由に詐称できる。ここで防げるのは
 * 「参加者のブラウザが、他サイトに置かれたページや埋め込みからAPIを叩かされる」
 * 経路——CSRFと他サイトからの読み取り——であって、攻撃者が自分の手元から直接
 * 叩くことではない。後者はチームコードの規則判定（配布した6桁を知らないと入れない）と
 * レート制限で被害を抑える。推測不能なセッション資格情報の導入は本実装フェーズの課題とする。
 */

/** 比較用の正規化。前後の空白と末尾スラッシュを落とす（`https://x/`と`https://x`を同一視する）。 */
const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, "");

/** カンマ区切りの`ALLOWED_ORIGINS`を配列へ。未設定・空文字は空配列（＝同一オリジンのみ許可）。 */
export const parseAllowedOrigins = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter((origin) => origin.length > 0);

/**
 * Originヘッダーが許可集合に含まれるか。`allowedOrigins`が空なら
 * 「リクエストURLと同じorigin」だけを許可する（同一オリジン配信の既定）。
 */
export const isOriginAllowed = (
  originHeader: string | null,
  requestUrl: URL,
  allowedOrigins: readonly string[],
): boolean => {
  if (originHeader === null) return false;
  const origin = normalizeOrigin(originHeader);
  // 同一オリジンは常に許可する。ALLOWED_ORIGINSは「追加で許可するオリジン」であって、
  // 許可集合の置き換えではない——別オリジンを1つ足したとたんに、配信元である自分自身が
  // 弾かれてモックが動かなくなる、という踏み方をしないため。
  if (origin === requestUrl.origin) return true;
  return allowedOrigins.some((candidate) => normalizeOrigin(candidate) === origin);
};

/**
 * Originヘッダーが無いリクエストを通してよいか。
 *
 * ブラウザは同一オリジンのGETにOriginを付けない。会場前面の進捗ボードが叩く
 * `GET /api/progress/summary`がまさにこれで、Origin必須にすると同一オリジンでも
 * 落ちる。一方でPOSTは同一オリジンでもブラウザが必ずOriginを付けるので必須にできる。
 *
 * そこで、Originが無いGET（WebSocket upgradeもGET）は`Sec-Fetch-Site`が
 * `same-origin`/`none`のときだけ通す。`Sec-Fetch-*`はブラウザが付ける禁止ヘッダーで、
 * ページ側のJSからは書き換えられない。つまりこの緩和は「別サイトのページから
 * 送られたGET」を弾きつつ、同一オリジンのブラウザからは全APIが動く状態を保つ。
 *
 * 非ブラウザのクライアントはこのヘッダーを自由に付けられるので、ここで拒否できるのは
 * 「素のcurl」までであり、防御の当てにはしない（このファイル先頭の注記を参照）。
 */
export const isOriginlessRequestAllowed = (method: string, secFetchSite: string | null): boolean =>
  method === "GET" && (secFetchSite === "same-origin" || secFetchSite === "none");

/** Origin検証の総合判定。Originがあれば許可集合と突合し、無ければGET限定の緩和へ回す。 */
export const isApiRequestAllowed = (
  request: Pick<Request, "method" | "headers">,
  requestUrl: URL,
  allowedOrigins: readonly string[],
): boolean => {
  const origin = request.headers.get("Origin");
  return origin === null
    ? isOriginlessRequestAllowed(request.method, request.headers.get("Sec-Fetch-Site"))
    : isOriginAllowed(origin, requestUrl, allowedOrigins);
};

/** 許可済みリクエストへ付けるCORSヘッダー（同一オリジンなら空）。 */
export type CorsHeaders = Readonly<Record<string, string>>;

/**
 * 別オリジンからの許可済みリクエストへ返すCORSヘッダーを組み立てる。
 *
 * エコーするのは`allowedOrigins`の判定を通ったOriginだけである。前作Hell-AI-v2では
 * `origin || "*"`を無条件にエコーして、任意のサイトからAPIを読めるようにしてしまった。
 * ここで許可判定をもう一度通すことで、呼び出し位置に関係なくその事故を再現できない。
 *
 * 同一オリジン（リクエストURLと同じorigin）には何も付けない——CORSが不要だからで、
 * 付けても無害だが、付いていること自体が「別オリジンを許可している」という誤読を生む。
 */
export const corsHeadersFor = (
  originHeader: string | null,
  requestUrl: URL,
  allowedOrigins: readonly string[],
): CorsHeaders => {
  if (originHeader === null) return {};
  const origin = normalizeOrigin(originHeader);
  if (origin === requestUrl.origin) return {};
  if (!isOriginAllowed(originHeader, requestUrl, allowedOrigins)) return {};
  // Varyが無いと、別オリジン向けの応答が同一オリジン用としてキャッシュされうる。
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
};

/**
 * チームコードの判定規則。コードは`[開催回2桁][チーム番号4桁]`で、許可リストを
 * 持たずに規則だけで判定する（予備チームは「次の番号」を配れば済み、事前登録が要らない）。
 *
 * - `open`: `EVENT_NO`が未設定。6桁なら何でも通す。ローカル開発とE2Eを壊さないための
 *   意図的なfail-openで、この既定は維持する（設定漏れは`GET /api/health`のguardsで検知する）。
 * - `rule`: 上2桁が`eventNo`と一致し、下4桁が1〜`teamMax`のコードだけを通す。
 * - `invalid`: 設定されているが値が壊れている。すべて拒否する（fail-closed）——一部だけ
 *   通すと、当日「入れるチームと入れないチームがある」といういちばん切り分けにくい形で壊れる。
 *   どちらの変数が壊れているかはhealthで見分けられるようにする。
 */
export type TeamCodeRule =
  | { readonly kind: "open" }
  | { readonly kind: "rule"; readonly eventNo: string; readonly teamMax: number }
  | { readonly kind: "invalid"; readonly reason: "eventNo" }
  | { readonly kind: "invalid"; readonly reason: "teamMax"; readonly eventNo: string };

/** `TEAM_MAX`未設定時のチーム番号の上限。企画上の最大（10チーム）に対して十分広く取る。 */
export const DEFAULT_TEAM_MAX = 100;

/** チーム番号は4桁なので、上限もそこで頭打ちにする。 */
export const MAX_TEAM_MAX = 9999;

/** 開催回は2桁数字ちょうど（`02`のように0埋めして書く）。 */
const EVENT_NO_PATTERN = /^\d{2}$/;

/**
 * `TEAM_MAX`を上限値へ。未設定は既定へ倒すが、設定されていて正の整数（1〜9999）でない
 * ものはnullを返してfail-closedにする——ここを既定へ倒すと、書き損じたまま
 * 「設定したつもりの上限」と違う範囲で当日が動く。
 *
 * 数字だけの表記に限る。`Number`任せにすると`1e2`や`0x10`が黙って通り、
 * 書いた値と効いている上限がずれる。
 */
const parseTeamMax = (raw: string | undefined): number | null => {
  if (raw === undefined) return DEFAULT_TEAM_MAX;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= MAX_TEAM_MAX ? parsed : null;
};

/**
 * `EVENT_NO`と`TEAM_MAX`から判定規則を組み立てる。`EVENT_NO`を先に見るのは、未設定なら
 * 規則そのものが効かず`TEAM_MAX`を読む意味が無いためで、healthの表示もそれに従う。
 */
export const parseTeamCodeRule = (env: Pick<Env, "EVENT_NO" | "TEAM_MAX">): TeamCodeRule => {
  if (env.EVENT_NO === undefined) return { kind: "open" };
  const eventNo = env.EVENT_NO.trim();
  if (!EVENT_NO_PATTERN.test(eventNo)) return { kind: "invalid", reason: "eventNo" };
  const teamMax = parseTeamMax(env.TEAM_MAX);
  if (teamMax === null) return { kind: "invalid", reason: "teamMax", eventNo };
  return { kind: "rule", eventNo, teamMax };
};

/** 規則が無ければ（＝EVENT_NO未設定なら）6桁は何でも通す。 */
export const isTeamCodeAllowed = (code: string, rule: TeamCodeRule): boolean => {
  if (rule.kind === "invalid") return false;
  if (!teamCodeSchema.safeParse(code).success) return false;
  if (rule.kind === "open") return true;
  if (code.slice(0, 2) !== rule.eventNo) return false;
  const teamNo = Number(code.slice(2));
  return teamNo >= 1 && teamNo <= rule.teamMax;
};

/**
 * `GET /api/health`のguardsへ載せる表示。healthはOrigin不問で誰でも読めるので、
 * `eventNo`は値を出さず設定の有無だけを返す——開催回が分かると、通るコードの範囲が
 * 6桁全体から1万通りへ狭まる。`teamMax`は数値のまま出す（当日の運用者が効いている
 * 上限を確認できないと、配布数を増やしたときの取りこぼしに気付けない）。
 * 規則が効いていない項目は`false`を返す。
 */
export const teamCodeRuleStatus = (
  rule: TeamCodeRule,
): { eventNo: boolean | "invalid"; teamMax: number | "invalid" | false } => {
  if (rule.kind === "open") return { eventNo: false, teamMax: false };
  if (rule.kind === "rule") return { eventNo: true, teamMax: rule.teamMax };
  // EVENT_NOが壊れているときはTEAM_MAXを読んでいないので、teamMaxはfalseのまま出す。
  return rule.reason === "eventNo"
    ? { eventNo: "invalid", teamMax: false }
    : { eventNo: true, teamMax: "invalid" };
};

export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 既定の上限。研修中の1チームが1分に20通を超えるのは操作ミスか暴走とみなす。 */
export const DEFAULT_CHAT_RATE_LIMIT = 20;

/**
 * 活動ログの上限。1ステージあたり提出・判定・罠・復帰で数件、参加者の操作でも
 * 数十件に収まる。チャットと同じ固定窓を使うが枠は別に数える——ログが詰まって
 * ゲーム操作が止まる、あるいはその逆を起こさないため。
 */
export const ACTIVITY_RATE_LIMIT_PER_MINUTE = 120;

/**
 * 受け付ける上限値の範囲。1未満は「1通も送れない」で研修が成立せず、600（毎秒10通）を
 * 超える値は制限として意味を持たない。`1e100`のような指数表記や桁あふれを既定へ倒し、
 * 設定ミスがそのまま「実質無制限」にならないようにする。
 */
export const MIN_CHAT_RATE_LIMIT = 1;
export const MAX_CHAT_RATE_LIMIT = 600;

/**
 * `CHAT_RATE_LIMIT_PER_MINUTE`を上限値へ。未設定・非数値・範囲外はすべて既定へ倒す
 * （設定ミスでAPIを止めない）。実際に効いている値は`GET /api/health`のguardsに出るので、
 * 黙って既定へ落ちたことに気付けるようにしてある。
 */
export const parseChatRateLimit = (raw: string | undefined): number => {
  const parsed = Number(raw);
  const usable =
    Number.isSafeInteger(parsed) && parsed >= MIN_CHAT_RATE_LIMIT && parsed <= MAX_CHAT_RATE_LIMIT;
  return usable ? parsed : DEFAULT_CHAT_RATE_LIMIT;
};

/** 固定窓のキー。同じ窓に入る時刻は同じ文字列になる。 */
export const rateLimitBucket = (nowMs: number, windowMs: number): string =>
  String(Math.floor(nowMs / windowMs));

/** 現在の窓が明けるまでの秒数。0秒を返さないよう最低1秒に切り上げる。 */
export const rateLimitRetryAfterSeconds = (nowMs: number, windowMs: number): number => {
  const windowEndMs = (Math.floor(nowMs / windowMs) + 1) * windowMs;
  return Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
};

// ---- Durable Object RPCの補助入力 ----

/**
 * DOのRPCが受け取る補助入力の検証。commandやteamCodeと違いWorker側で組み立てる値だが、
 * DOのRPCは外から呼べる境界なので同じように実行時検証する。素通しすると、NaNとの
 * 比較が常にfalseになってレート制限が黙って無効化されたり、窓の計算が壊れたりする。
 * 弾いた入力はDOが例外にし、Worker側のcatchが503へ倒す。
 */
export const nowMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);

/** 1窓あたりの上限値。用途を問わずチャット側の上限を天井として共用する。 */
export const rateLimitCountSchema = z.number().int().positive().max(MAX_CHAT_RATE_LIMIT);

/** 送信内容の指紋。SHA-256の16進64桁（小文字）だけを受け付ける。 */
export const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** クレームの世代番号。1から始まる正の整数。 */
export const claimGenerationSchema = z.number().int().positive();

export const beginChatGateSchema = z
  .object({ nowMs: nowMsSchema, limit: rateLimitCountSchema, fingerprint: fingerprintSchema })
  .strict();

/**
 * AI呼び出しの顛末。`text`はここでは長さを見ない——上限超過は
 * normalizeAssistantTextが切り詰めるので、拒否にすると再送で同じ応答が返るだけになる。
 */
export const completeChatOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), text: z.string() }).strict(),
  z.object({ kind: z.literal("failure") }).strict(),
]);
