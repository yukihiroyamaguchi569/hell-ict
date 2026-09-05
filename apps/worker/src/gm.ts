import { publicTeamId, sha256Hex, teamCodeSchema } from "@hell-ict/domain";
import type { TeamCode } from "@hell-ict/domain";

import { recordGmReset } from "./activity-log.js";
import { isTeamCodeAllowed, parseTeamCodeRule } from "./guard.js";
import { error, json, teamCodeFromPath } from "./http.js";
import { listProgressTeamCodes, recordProgressReset } from "./progress.js";

/**
 * ゲームマスター専用のリセット（`POST /api/gm/teams/:code/reset`、
 * `POST /api/gm/teams/by-public-id/:publicId/reset`）。
 *
 * チェックポイントは後退を拒否するので、同じコードでテストプレイをやり直せない。
 * また当日、2チームが同じコードへ入ってしまったといった事故から復旧する手段が要る。
 * その2つのためだけの経路であり、本番当日は原則使わない（docs/development-harness.md）。
 *
 * 資格情報は`ADMIN_TOKEN`（secret）1つで、`Authorization: Bearer <token>`で渡す。
 * 未設定・不一致・規則外のコード・未知のpublicIdは、すべて経路が無いときと同じ404へ
 * 揃える——「トークンが違う」と「そのチームは居ない」を返し分けると、外から
 * 存在の有無を確かめられてしまう。
 *
 * 消えるのはDurable Objectのチーム状態と帯の行だけで、D1の活動ログと進捗イベントの
 * 過去行は残す（何が起きたかの記録は消さない）。
 */

/** 経路が無いときと同じ応答。GM系はすべてこれへ揃える。 */
const notFound = (): Response => new Response("Not found", { status: 404 });

/** publicIdは`publicTeamId`（SHA-256の先頭8桁）。小文字16進8桁だけを受ける。 */
const PUBLIC_TEAM_ID_PATTERN = /^[0-9a-f]{8}$/;

const BEARER_PATTERN = /^Bearer (.+)$/;

const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  return BEARER_PATTERN.exec(header)?.[1] ?? null;
};

/**
 * トークンの照合。両方をSHA-256で16進64桁へ畳んでから、途中で抜けずに全桁を比べる。
 *
 * 生の文字列を`===`で比べると、一致した接頭辞の長さと文字列長が応答時間へ出る。
 * ハッシュを介せば長さは常に64桁で揃い、比較そのものも入力に依存しない回数で終わる
 * （JSのエンジンは定数時間を保証しないが、秘密の長さと接頭辞が漏れる経路は塞げる）。
 */
const matchesAdminToken = async (provided: string, expected: string): Promise<boolean> => {
  const [providedHash, expectedHash] = await Promise.all([
    sha256Hex(provided),
    sha256Hex(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < providedHash.length; index += 1) {
    difference |= providedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
};

/**
 * `ADMIN_TOKEN`が未設定（または空文字）なら、GM系ルートは常に閉じる。設定漏れのまま
 * 誰でも押せる状態を作らないためのfail-closedで、この既定は緩めない。
 */
const isGmAuthorized = async (request: Request, env: Env): Promise<boolean> => {
  const expected = env.ADMIN_TOKEN;
  if (expected === undefined || expected === "") return false;
  const provided = bearerToken(request);
  return provided === null ? false : matchesAdminToken(provided, expected);
};

const publicIdFromPath = (pathname: string): string | null => {
  const prefix = "/api/gm/teams/by-public-id/";
  const suffix = "/reset";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const value = pathname.slice(prefix.length, -suffix.length);
  return PUBLIC_TEAM_ID_PATTERN.test(value) ? value : null;
};

/**
 * publicIdからチームコードを引く。ダッシュボードはチームコードを表示しない設計なので
 * （見えた時点でそのチームへ入室できる）、リセット対象はpublicIdでしか指せない。
 *
 * 候補はD1の`progress_events`に出ているチームに限る。ダッシュボードの行はまさに
 * その集計なので、画面に出ているチームは必ず引ける。総当たり（規則の範囲を全部
 * ハッシュする）と違い、`EVENT_NO`が未設定でも同じ経路で動く。
 */
const teamCodeFromPublicId = async (env: Env, publicId: string): Promise<TeamCode | null> => {
  const codes = (await listProgressTeamCodes(env.PROGRESS_DB))
    .map((code) => teamCodeSchema.safeParse(code).data)
    .filter((code) => code !== undefined);
  const ids = await Promise.all(codes.map((code) => publicTeamId(code)));
  const index = ids.indexOf(publicId);
  return index === -1 ? null : (codes[index] ?? null);
};

/** リセット対象を、publicId版と`:code`版のどちらの経路からも1つのTeamCodeへ落とす。 */
const gmTargetTeamCode = async (env: Env, pathname: string): Promise<TeamCode | null> => {
  const publicId = publicIdFromPath(pathname);
  return publicId === null
    ? teamCodeFromPath(pathname, "/api/gm/teams/", "/reset")
    : teamCodeFromPublicId(env, publicId);
};

/**
 * 実際の初期化。Durable Objectを空にしてから、D1へ「リセットした」ことを残す。
 *
 * 記録の失敗を握り潰さないのは、ダッシュボードの位置がD1の`reset`行で戻るからである
 * ——黙って200を返すと、GMは戻ったつもりで戻っていない盤面を見ることになる。
 * リセットは何度実行しても同じ結果になるので、そのまま押し直せばよい。
 */
const resetTeam = async (env: Env, teamCode: TeamCode): Promise<Response> => {
  let generation: number;
  try {
    const room = env.TEAM_ROOM.getByName(teamCode);
    await room.resetTeam(teamCode);
    // リセット後の世代。進捗イベントのreset行へ入れると、これが以後の集計の下限になる
    // ——照合を通った後に積まれた古い世代の行を、行の列だけで見分けられる。
    generation = await room.resetGeneration(teamCode);
    await env.RACE_LEADERBOARD.getByName("global").resetTeam(teamCode);
  } catch {
    return error("チーム状態のリセットに失敗しました。時間を置いて再試行してください。", 503);
  }
  try {
    await recordProgressReset(env, teamCode, generation);
    await recordGmReset(env, teamCode);
  } catch {
    return error("リセットは実行しましたが、記録に失敗しました。もう一度実行してください。", 503);
  }
  return json({ ok: true });
};

/**
 * `/api/gm/`配下のPOSTをすべて受ける。判定順は、Origin検証（入口ガードで済み）→
 * トークン→対象の特定→規則判定→実行。トークンを最初に見るので、未知のパスも
 * 規則外のコードも、認証を通っていない相手には区別が付かない。
 */
export const handleGmReset = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!(await isGmAuthorized(request, env))) return notFound();
  let teamCode: TeamCode | null;
  try {
    teamCode = await gmTargetTeamCode(env, url.pathname);
  } catch {
    return error("リセット対象の特定に失敗しました。時間を置いて再試行してください。", 503);
  }
  if (teamCode === null || !isTeamCodeAllowed(teamCode, parseTeamCodeRule(env))) return notFound();
  return resetTeam(env, teamCode);
};
