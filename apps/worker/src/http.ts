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
export const parseJson = async (request: Request): Promise<unknown> => request.json();
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
