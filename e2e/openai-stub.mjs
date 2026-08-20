import { createServer } from "node:http";

/**
 * OpenAI Chat Completions APIの最小スタブ。E2Eでは実キーを使わず、
 * wrangler devへ `--var OPENAI_BASE_URL:http://127.0.0.1:<port>` で
 * このサーバーを指させる（本番コードに分岐を足さず、設定値だけを差し替える）。
 */
const port = Number(process.env.OPENAI_STUB_PORT ?? "8789");

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    void body;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "（スタブ応答）承知しました。" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`openai-stub listening on http://127.0.0.1:${String(port)}\n`);
});
