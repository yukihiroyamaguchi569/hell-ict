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
/** 本文が上限を超えたときにparseJsonが投げる。413へ変換するため他の失敗と区別する。 */
export class PayloadTooLargeError extends Error {}

const bodyEncoder = new TextEncoder();

/**
 * `maxBytes`を渡すと、本文をJSONへ展開する前にバイト数で弾く——巨大なJSONを
 * request.json()へ通すと、上限を検証する前に展開だけでメモリを食う。
 *
 * Content-Lengthがあればそれを見て、読む前に打ち切る。ヘッダは偽装できる（chunked
 * 転送では付かない）ので、テキストとして読んだ実バイト数でも必ず測り直す。
 * どちらの経路でも、上限を超えた文字列がJSON.parseへ渡ることはない。
 *
 * 上限を渡さない既存の呼び出しは、これまでどおりrequest.json()へ素通しする。
 * 現在の呼び出し側はチェックポイント保存（96KB）と活動ログ（64KB）。
 */
export const parseJson = async (request: Request, maxBytes?: number): Promise<unknown> => {
  if (maxBytes === undefined) return request.json();
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  const body = await request.text();
  if (bodyEncoder.encode(body).length > maxBytes) throw new PayloadTooLargeError();
  return JSON.parse(body) as unknown;
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
