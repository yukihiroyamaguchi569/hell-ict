import { teamCodeSchema } from "@hell-ict/domain";
import type { TeamCode } from "@hell-ict/domain";

export const json = (value: unknown, status = 200): Response => Response.json(value, { status });
export const error = (message: string, status: number): Response => json({ message }, status);
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
