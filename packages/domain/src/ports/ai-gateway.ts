export interface AiRequest {
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface AiGateway {
  complete(request: AiRequest): Promise<string>;
}
