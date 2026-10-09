/**
 * The case file: what the bench sends. Each case is one call of the Worker, with the system
 * prompt already in front of the conversation, exactly as the Worker sends it.
 */

const ROLES = ["system", "user", "assistant"] as const;
type Role = (typeof ROLES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRole = (value: unknown): value is Role => ROLES.some((role) => role === value);

const requireString = (record: Record<string, unknown>, key: string, where: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
};

const parseMessage = (value: unknown, where: string) => {
  if (!isRecord(value)) throw new Error(`${where}: must be an object`);
  const { role } = value;
  if (!isRole(role)) throw new Error(`${where}: "role" must be one of ${ROLES.join(", ")}`);
  return { role, content: requireString(value, "content", where) };
};

export type BenchMessage = ReturnType<typeof parseMessage>;

const parseMessages = (value: unknown, where: string): readonly BenchMessage[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where}: "messages" must be a non-empty array`);
  }
  const messages = value.map((message: unknown, index) =>
    parseMessage(message, `${where}.messages[${String(index)}]`),
  );
  if (messages.at(-1)?.role !== "user") {
    throw new Error(`${where}: the last message must be from the user`);
  }
  return messages;
};

const parseCase = (value: unknown, where: string) => {
  if (!isRecord(value)) throw new Error(`${where}: must be an object`);
  return {
    id: requireString(value, "id", where),
    stage: requireString(value, "stage", where),
    label: requireString(value, "label", where),
    messages: parseMessages(value.messages, where),
  };
};

export type BenchCase = ReturnType<typeof parseCase>;

/** Validates the parsed JSON of a case file. Ids must be unique: the report is keyed by them. */
export const parseCases = (value: unknown): readonly BenchCase[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("cases: must be a non-empty array");
  }
  const cases = value.map((item: unknown, index) => parseCase(item, `cases[${String(index)}]`));
  const seen = new Set<string>();
  for (const benchCase of cases) {
    if (seen.has(benchCase.id)) throw new Error(`cases: duplicate id "${benchCase.id}"`);
    seen.add(benchCase.id);
  }
  return cases;
};

/**
 * A rough token count for the dry run, without a tokenizer: about one token per Japanese
 * character and one per four ASCII characters. Good to a factor of about 1.5 either way.
 */
export const estimateTokens = (text: string): number => {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(other + ascii / 4);
};

export const estimateCaseTokens = (benchCase: BenchCase): number =>
  benchCase.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
