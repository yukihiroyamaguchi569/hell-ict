import type { ProviderName } from "./providers.ts";

/**
 * Models compared by the bench, with the provider that serves each, the parameters the Worker
 * would add and the price used for the cost estimate. The Worker sends only `model` and
 * `messages`; a model that reasons by default gets the parameter that turns its reasoning off or
 * down, because the game never asks for it.
 *
 * Prices and parameters were checked in each provider's documentation on 2026-10-10:
 * - Gemini: https://ai.google.dev/gemini-api/docs/pricing (output prices include thinking) and
 *   https://ai.google.dev/gemini-api/docs/openai (`reasoning_effort`: Gemini 3 models cannot turn
 *   thinking off, `minimal` is their lowest; `none` turns it off on 2.5 models)
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing and
 *   https://platform.claude.com/docs/en/build-with-claude/thinking (the compatibility layer ignores
 *   `reasoning_effort` but passes `thinking` through; Haiku 5.5 accepts `disabled`, Sonnet 5.5's
 *   lowest is `between_tools`, Haiku 4.5 does not think unless asked)
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ModelParams = Readonly<Record<string, JsonValue>>;

/** USD per one million tokens. */
export type ModelPrice = { readonly input: number; readonly output: number };

export type ModelSpec = {
  readonly name: string;
  readonly provider: ProviderName;
  readonly params: ModelParams;
  /** null when the model is not in the table below: the cost is then shown as unknown. */
  readonly price: ModelPrice | null;
};

const KNOWN_MODELS: readonly ModelSpec[] = [
  { name: "gpt-4o", provider: "openai", params: {}, price: { input: 2.5, output: 10 } },
  { name: "gpt-4.1", provider: "openai", params: {}, price: { input: 2, output: 8 } },
  { name: "gpt-4.1-mini", provider: "openai", params: {}, price: { input: 0.4, output: 1.6 } },
  {
    name: "gpt-6-sol",
    provider: "openai",
    params: { reasoning_effort: "none" },
    price: { input: 2, output: 10 },
  },
  // The price through 2026-12-31; it doubles from 2027-01-01.
  {
    name: "gemini-3.8-flash",
    provider: "gemini",
    params: { reasoning_effort: "minimal" },
    price: { input: 0.75, output: 3.75 },
  },
  {
    name: "gemini-3.1-flash-lite",
    provider: "gemini",
    params: { reasoning_effort: "minimal" },
    price: { input: 0.25, output: 1.5 },
  },
  {
    name: "gemini-2.5-flash",
    provider: "gemini",
    params: { reasoning_effort: "none" },
    price: { input: 0.3, output: 2.5 },
  },
  // The price for prompts up to 100,000 tokens (the game's are far shorter).
  {
    name: "claude-haiku-5-5",
    provider: "anthropic",
    params: { thinking: { type: "disabled" } },
    price: { input: 0.1, output: 0.5 },
  },
  {
    name: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    params: {},
    price: { input: 1, output: 5 },
  },
  {
    name: "claude-sonnet-5-5",
    provider: "anthropic",
    params: { thinking: { type: "between_tools" } },
    price: { input: 2, output: 10 },
  },
];

/** Compared when --models is not given: OpenAI's, so a run with only OPENAI_API_KEY still works. */
export const DEFAULT_MODEL_NAMES: readonly string[] = KNOWN_MODELS.filter(
  (model) => model.provider === "openai",
).map((model) => model.name);

export const KNOWN_MODEL_NAMES: readonly string[] = KNOWN_MODELS.map((model) => model.name);

/**
 * A model given on the command line. A model in the table brings its own provider (--provider
 * does not change it). One not in the table is sent as it is, with no price, to
 * `fallbackProvider` (--provider); without one it is refused rather than guessed from its name.
 */
export const modelSpecFor = (
  name: string,
  fallbackProvider: ProviderName | null = null,
): ModelSpec => {
  const known = KNOWN_MODELS.find((model) => model.name === name);
  if (known !== undefined) return known;
  if (fallbackProvider === null) {
    throw new Error(`"${name}" is not in config.ts: pass --provider (openai, gemini or anthropic)`);
  }
  return { name, provider: fallbackProvider, params: {}, price: null };
};

/** The Worker gives up on the AI after this long (`CHAT_TIMEOUT_MS` in apps/worker/src/chat-turn.ts). */
export const PRODUCTION_TIMEOUT_MS = 20_000;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_REPEAT = 1;
