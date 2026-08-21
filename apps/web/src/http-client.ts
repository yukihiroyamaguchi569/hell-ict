import { httpErrorSchema } from "@hell-ict/domain";

/** サーバのエラー応答（{message}）とHTTPステータスを保持する。呼び出し元が理由で分岐できるようにする。 */
export class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as unknown;
  if (!response.ok) {
    const error = httpErrorSchema.safeParse(parsed);
    throw new HttpRequestError(response.status, error.success ? error.data.message : "");
  }
  return parsed;
};
