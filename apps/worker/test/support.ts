import { exports } from "cloudflare:workers";

/**
 * ブラウザは同一オリジンのPOST・WebSocketにも必ずOriginを付ける。入口ガード
 * （src/guard.ts）を通すため、テストのリクエストも実ブラウザと同じ形にする。
 */
export const TEST_ORIGIN = "https://example.test";

export const postJson = async (path: string, body: unknown): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Origin: TEST_ORIGIN },
    }),
  );

/**
 * ブラウザの同一オリジンGETを模す。GETにはOriginが付かないので、入口ガードは
 * `Sec-Fetch-Site`を見て通す（src/guard.tsのisOriginlessRequestAllowed）。
 */
export const get = async (path: string): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } }),
  );

export const session = async (teamCode: string): Promise<Response> =>
  postJson("/api/session", { teamCode });

export const upgrade = async (path: string): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      headers: { Upgrade: "websocket", Origin: TEST_ORIGIN },
    }),
  );

/** WebSocket接続直後に届くメッセージを`count`件集めてから切断する。 */
export const collectMessages = (response: Response, count: number): Promise<unknown[]> => {
  const socket = response.webSocket;
  if (socket === null) throw new Error("101応答にWebSocketがありません。");
  const received: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      try {
        received.push(typeof event.data === "string" ? (JSON.parse(event.data) as unknown) : null);
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
        return;
      }
      if (received.length >= count) resolve();
    });
    socket.addEventListener("close", () => {
      reject(new Error(`${String(count)}件集める前にWebSocketが閉じました。`));
    });
    socket.addEventListener("error", () => {
      reject(new Error("WebSocketでエラーが発生しました。"));
    });
  });
  socket.accept();
  return done.then(() => {
    socket.close();
    return received;
  });
};

export const firstMessage = async (response: Response): Promise<unknown> => {
  const [message] = await collectMessages(response, 1);
  return message;
};
