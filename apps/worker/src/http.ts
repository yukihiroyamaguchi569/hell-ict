import { teamCodeSchema } from "@hell-ict/domain";
import type { HttpErrorCode, TeamCode } from "@hell-ict/domain";

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

/**
 * `/api/teams/:code/...`のcodeを、末尾のパスを問わず取り出す。入口ガードは
 * 個別エンドポイントを知らずに許可リストを当てたいので、teamCodeFromPathとは別に置く。
 */
export const teamCodeFromApiPath = (pathname: string): TeamCode | null => {
  const prefix = "/api/teams/";
  if (!pathname.startsWith(prefix)) return null;
  const [code] = pathname.slice(prefix.length).split("/");
  return teamCodeSchema.safeParse(code).data ?? null;
};
