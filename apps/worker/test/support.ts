import { exports } from "cloudflare:workers";

export const postJson = async (path: string, body: unknown): Promise<Response> =>
  exports.default.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

export const session = async (teamCode: string): Promise<Response> =>
  postJson("/api/session", { teamCode });

export const upgrade = async (path: string): Promise<Response> =>
  exports.default.fetch(
    new Request(`https://example.test${path}`, { headers: { Upgrade: "websocket" } }),
  );

/** WebSocket接続直後に届くメッセージを`count`件集めてから切断する。 */
export const collectMessages = (response: Response, count: number): Promise<unknown[]> => {
  const socket = response.webSocket;
  if (socket === null) throw new Error("101応答にWebSocketがありません。");
  const received: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      received.push(typeof event.data === "string" ? (JSON.parse(event.data) as unknown) : null);
      if (received.length >= count) resolve();
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
