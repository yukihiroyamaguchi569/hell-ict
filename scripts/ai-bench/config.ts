/**
 * Models compared by the bench, with the parameters the Worker would add for each and the price
 * used for the cost estimate. The Worker sends only `model` and `messages`; a reasoning model gets
 * `reasoning_effort: "none"` here because it reasons by default, which the game never asks for.
 */

export type ModelParams = Readonly<Record<string, string | number | boolean>>;

/** USD per one million tokens. */
export type ModelPrice = { readonly input: number; readonly output: number };

export type ModelSpec = {
  readonly name: string;
  readonly params: ModelParams;
  /** null when the model is not in the table below: the cost is then shown as unknown. */
  readonly price: ModelPrice | null;
};

const KNOWN_MODELS: readonly ModelSpec[] = [
  { name: "gpt-4o", params: {}, price: { input: 2.5, output: 10 } },
  { name: "gpt-4.1", params: {}, price: { input: 2, output: 8 } },
  { name: "gpt-4.1-mini", params: {}, price: { input: 0.4, output: 1.6 } },
  { name: "gpt-6-sol", params: { reasoning_effort: "none" }, price: { input: 2, output: 10 } },
];

export const DEFAULT_MODEL_NAMES: readonly string[] = KNOWN_MODELS.map((model) => model.name);

/** A model given on the command line. One not in the table is sent as it is, with no price. */
export const modelSpecFor = (name: string): ModelSpec =>
  KNOWN_MODELS.find((model) => model.name === name) ?? { name, params: {}, price: null };

/** The Worker gives up on the AI after this long (`CHAT_TIMEOUT_MS` in apps/worker/src/chat-turn.ts). */
export const PRODUCTION_TIMEOUT_MS = 20_000;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_REPEAT = 1;
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
