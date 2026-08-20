import { parseExternalMessage } from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";

export class HarnessCounter extends DurableObject<Env> {
  async increment(): Promise<number> {
    const current = (await this.ctx.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}

const badRequest = (message: string): Response => Response.json({ message }, { status: 400 });

const parseJson = async (request: Request): Promise<unknown> => request.json();

const handleEcho = async (request: Request): Promise<Response> => {
  try {
    const input = await parseJson(request);
    return Response.json(parseExternalMessage(input));
  } catch {
    return badRequest("messageは1〜280文字の文字列で指定してください。");
  }
};

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/echo") {
      return handleEcho(request);
    }
    if (request.method === "POST" && url.pathname === "/harness/increment") {
      return Response.json({ count: await env.HARNESS_COUNTER.getByName("singleton").increment() });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export default worker;
