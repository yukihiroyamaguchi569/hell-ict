import type { AiGateway, AiRequest, AiResponse } from "../ports/ai-gateway.js";

export type FakeAiOutcome =
  | { readonly kind: "success"; readonly response: string }
  | { readonly kind: "failure"; readonly error: Error }
  | { readonly kind: "timeout" };

export class FakeAiGateway implements AiGateway {
  readonly requests: AiRequest[] = [];

  constructor(private readonly outcomes: readonly FakeAiOutcome[]) {}

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    const outcome = this.outcomes.at(this.requests.length - 1);
    if (outcome === undefined) {
      return Promise.reject(new Error("FakeAiGatewayに結果が設定されていません。"));
    }
    if (outcome.kind === "success") {
      return Promise.resolve({ text: outcome.response });
    }
    if (outcome.kind === "failure") {
      return Promise.reject(outcome.error);
    }
    return Promise.reject(
      new Error(`AI応答が${String(request.timeoutMs)}ms以内に完了しませんでした。`),
    );
  }
}
