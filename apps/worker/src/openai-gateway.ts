import { parseOpenAiChatCompletion } from "@hell-ict/domain";
import type { AiGateway, AiMessage, AiRequest, AiResponse } from "@hell-ict/domain";

/**
 * `AiGateway`のOpenAI adapter。domainからCloudflare/OpenAIを直接importさせないため、
 * ここWorker側だけに置く。APIキーはこの呼び出しの外へは出さない。
 */
export class OpenAiGateway implements AiGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages.map((message: AiMessage) => ({
            role: message.role,
            content: message.text,
          })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenAI応答が異常です（status ${String(response.status)}）。`);
      }
      const completion = parseOpenAiChatCompletion(await response.json());
      const text = completion.choices[0]?.message.content;
      if (text === undefined) throw new Error("OpenAI応答にcontentがありません。");
      return { text };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createAiGateway = (env: Env): AiGateway =>
  new OpenAiGateway(env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.OPENAI_MODEL);
