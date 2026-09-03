import { teamCodeSchema } from "@hell-ict/domain";
import type { HttpErrorCode, TeamCode } from "@hell-ict/domain";

/**
 * fetchが受け取るenvとExecutionContextを束ねたもの。活動ログを`waitUntil`へ
 * 逃がすためにハンドラの奥までctxを届ける必要があるが、envとctxを別引数で
 * 引き回すとmax-params（4）に収まらなくなるため1つにまとめる。
 */
export type RequestScope = { readonly env: Env; readonly ctx: ExecutionContext };

export const json = (value: unknown, status = 200): Response => Response.json(value, { status });
export const error = (message: string, status: number, code?: HttpErrorCode): Response =>
  json(code === undefined ? { message } : { message, code }, status);
/** 本文が大きすぎたことを、JSONとして壊れている（400）と区別するための印。 */
export class PayloadTooLargeError extends Error {}

/**
 * JSON本文を読む。`maxBytes`を渡すと、その大きさを超える本文をオブジェクトへ展開する
 * 前に拒否する——巨大なJSONをrequest.json()へ通すと、上限を検証する前に展開だけで
 * メモリを食う。Content-Lengthは申告されないことも偽られることもあるので、
 * ヘッダーで弾けなければテキストとして読み、実バイト長で確かめてからparseする。
 */
export const parseJson = async (request: Request, maxBytes?: number): Promise<unknown> => {
  if (maxBytes === undefined) return request.json();
  const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (declared > maxBytes) throw new PayloadTooLargeError();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new PayloadTooLargeError();
  return JSON.parse(text) as unknown;
};
export const isWebSocketRequest = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

export const teamCodeFromPath = (
  pathname: string,
  prefix: string,
  suffix: string,
): TeamCode | null => {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  return teamCodeSchema.safeParse(pathname.slice(prefix.length, -suffix.length)).data ?? null;
};
