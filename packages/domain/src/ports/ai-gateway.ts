export interface AiMessage {
  readonly role: "system" | "user" | "assistant";
  readonly text: string;
}

export interface AiRequest {
  readonly messages: readonly AiMessage[];
  readonly timeoutMs: number;
}

export interface AiResponse {
  readonly text: string;
}

export interface AiGateway {
  complete(request: AiRequest): Promise<AiResponse>;
}
