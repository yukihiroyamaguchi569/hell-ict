/**
 * 公開Worker APIの入口ガード（Origin検証・チームコード許可リスト・チーム単位の
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
 * 叩くことではない。後者はTEAM_CODESの許可リスト（配布した6桁を知らないと入れない）と
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
  const allowed = allowedOrigins.length === 0 ? [requestUrl.origin] : allowedOrigins;
  const origin = normalizeOrigin(originHeader);
  return allowed.some((candidate) => normalizeOrigin(candidate) === origin);
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

/** カンマ区切りの`TEAM_CODES`を集合へ。未設定・空文字はnull（＝許可リストなし＝何でも通す）。 */
export const parseTeamCodes = (raw: string | undefined): ReadonlySet<string> | null => {
  const codes = (raw ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  return codes.length === 0 ? null : new Set(codes);
};

/** 許可リストが無ければ何でも通す（ローカル開発とE2Eの互換）。 */
export const isTeamCodeAllowed = (code: string, allowlist: ReadonlySet<string> | null): boolean =>
  allowlist === null || allowlist.has(code);

// ---- チャット送信のレート制限（固定窓） ----

/** 固定窓の幅。`CHAT_RATE_LIMIT_PER_MINUTE`が「1分あたり」を意味する根拠。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 既定の上限。研修中の1チームが1分に20通を超えるのは操作ミスか暴走とみなす。 */
export const DEFAULT_CHAT_RATE_LIMIT = 20;

/** `CHAT_RATE_LIMIT_PER_MINUTE`を上限値へ。未設定・不正値は既定へ倒す（設定ミスでAPIを止めない）。 */
export const parseChatRateLimit = (raw: string | undefined): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHAT_RATE_LIMIT;
};

/** 固定窓のキー。同じ窓に入る時刻は同じ文字列になる。 */
export const rateLimitBucket = (nowMs: number, windowMs: number): string =>
  String(Math.floor(nowMs / windowMs));

/** 現在の窓が明けるまでの秒数。0秒を返さないよう最低1秒に切り上げる。 */
export const rateLimitRetryAfterSeconds = (nowMs: number, windowMs: number): number => {
  const windowEndMs = (Math.floor(nowMs / windowMs) + 1) * windowMs;
  return Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
};
