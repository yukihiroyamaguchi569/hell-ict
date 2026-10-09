/**
 * The companies whose OpenAI-compatible Chat Completions endpoint the bench can call. All three
 * take the key as `Authorization: Bearer <key>` (checked in each provider's documentation,
 * 2026-10):
 * - OpenAI: https://platform.openai.com/docs/api-reference/chat
 * - Gemini: https://ai.google.dev/gemini-api/docs/openai
 * - Anthropic: https://platform.claude.com/docs/en/api/openai-sdk
 *
 * The keys are read from the environment only, one variable per provider, and only for the
 * providers a run uses.
 */

export const PROVIDER_NAMES = ["openai", "gemini", "anthropic"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Provider = {
  readonly name: ProviderName;
  readonly baseUrl: string;
  readonly keyEnv: string;
  /** Overrides `baseUrl`, for a local stub. */
  readonly baseUrlEnv: string;
  /** The rate-limit headers kept from each response. Empty: the provider documents none. */
  readonly rateLimitHeaders: readonly string[];
  /** The headers the load test reads for "the lowest remaining"; null when there is none. */
  readonly remainingRequestsHeader: string | null;
  readonly remainingTokensHeader: string | null;
};

const OPENAI_RATE_LIMIT_HEADERS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = {
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    rateLimitHeaders: OPENAI_RATE_LIMIT_HEADERS,
    remainingRequestsHeader: "x-ratelimit-remaining-requests",
    remainingTokensHeader: "x-ratelimit-remaining-tokens",
  },
  // The compatibility page and the rate-limit page name no response header for the limits; they
  // point to AI Studio (https://aistudio.google.com/rate-limit) instead.
  gemini: {
    name: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    baseUrlEnv: "GEMINI_BASE_URL",
    rateLimitHeaders: [],
    remainingRequestsHeader: null,
    remainingTokensHeader: null,
  },
  // The compatibility layer lists the OpenAI `x-ratelimit-*` headers as supported; the native
  // `anthropic-ratelimit-*` headers (https://platform.claude.com/docs/en/api/rate-limits) are kept
  // too, in case they come back as well.
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    rateLimitHeaders: [
      ...OPENAI_RATE_LIMIT_HEADERS,
      "anthropic-ratelimit-requests-remaining",
      "anthropic-ratelimit-input-tokens-remaining",
      "anthropic-ratelimit-output-tokens-remaining",
      "anthropic-ratelimit-tokens-remaining",
      "retry-after",
    ],
    remainingRequestsHeader: "x-ratelimit-remaining-requests",
    remainingTokensHeader: "x-ratelimit-remaining-tokens",
  },
};

export const isProviderName = (value: string): value is ProviderName =>
  PROVIDER_NAMES.some((name) => name === value);

export const parseProviderName = (raw: string): ProviderName => {
  const value = raw.trim();
  if (!isProviderName(value)) {
    throw new Error(`--provider must be one of ${PROVIDER_NAMES.join(", ")} (got "${raw}")`);
  }
  return value;
};

type Env = Readonly<Record<string, string | undefined>>;

export type Endpoint = { readonly baseUrl: string; readonly apiKey: string };

export const baseUrlOf = (env: Env, provider: ProviderName): string => {
  const { baseUrl, baseUrlEnv } = PROVIDERS[provider];
  return (env[baseUrlEnv]?.trim() || baseUrl).replace(/\/+$/, "");
};

/**
 * The endpoint of every provider in use. Throws before any call when a key is missing, naming
 * every missing variable at once (never the value of one that is set).
 */
export const readEndpoints = (
  env: Env,
  providers: readonly ProviderName[],
): ReadonlyMap<ProviderName, Endpoint> => {
  const unique = [...new Set(providers)];
  const missing = unique.filter((name) => (env[PROVIDERS[name].keyEnv]?.trim() ?? "") === "");
  if (missing.length > 0) {
    const vars = missing.map((name) => PROVIDERS[name].keyEnv);
    const steps = vars.map((name) => `read -s ${name}; export ${name}`).join("; ");
    throw new Error(
      `${vars.join(", ")} ${vars.length === 1 ? "is" : "are"} not set. Run \`${steps}\` first ` +
        "(or use --dry-run to check the cases without a key).",
    );
  }
  return new Map(
    unique.map((name) => [
      name,
      { baseUrl: baseUrlOf(env, name), apiKey: env[PROVIDERS[name].keyEnv]?.trim() ?? "" },
    ]),
  );
};
