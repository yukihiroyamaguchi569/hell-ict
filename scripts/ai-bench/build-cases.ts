import { parseCases } from "./cases.ts";
import type { BenchCase } from "./cases.ts";

/**
 * Turns picked conversations into bench cases by putting the stage's system prompt in front,
 * the way the Worker does it (`finishChatTurn` in apps/worker/src/chat-turn.ts: the system prompt
 * of `systemPromptFor(promptProfile)`, then the thread's saved history, then the new message).
 * `systemPromptFor` is the lookup `systemPrompts[promptProfile ?? "default"]`; it is repeated
 * here because the Worker's import resolves to the public dummy prompts, and the bench needs the
 * real ones, read from the scenario repo's `packages/content/src/prompts.ts`.
 *
 * The stage's profile is `stageAiPlan(stage).live.profile` (packages/domain/src/game/stage-ai.ts):
 * Stage 1 "s1", Stage 3 "s3", Stage 4 and 5 "default"; Stage 2 and 6 do not call the AI.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `systemPrompts` export of a prompts module: profile name → system prompt. */
export const parseSystemPrompts = (moduleExports: unknown): ReadonlyMap<string, string> => {
  const prompts = isRecord(moduleExports) ? moduleExports.systemPrompts : undefined;
  if (!isRecord(prompts)) throw new Error("the prompts module has no systemPrompts object");
  const entries = Object.entries(prompts).map(([profile, prompt]): [string, string] => {
    if (typeof prompt !== "string" || prompt === "") {
      throw new Error(`systemPrompts.${profile} must be a non-empty string`);
    }
    return [profile, prompt];
  });
  return new Map(entries);
};

const parsePick = (value: unknown, index: number): { promptProfile: string; raw: unknown } => {
  if (!isRecord(value)) throw new Error(`picks[${String(index)}]: must be an object`);
  const { promptProfile } = value;
  if (promptProfile !== undefined && typeof promptProfile !== "string") {
    throw new Error(`picks[${String(index)}]: "promptProfile" must be a string`);
  }
  return { promptProfile: promptProfile ?? "default", raw: value };
};

/**
 * A pick is a case without the system prompt, plus the `promptProfile` its stage uses
 * (absent means "default"). Its messages are the participant's turns and the AI's replies.
 */
export const buildCases = (
  picks: unknown,
  prompts: ReadonlyMap<string, string>,
): readonly BenchCase[] => {
  if (!Array.isArray(picks)) throw new Error("picks: must be an array");
  const withSystem = picks.map((value: unknown, index) => {
    const { promptProfile, raw } = parsePick(value, index);
    const system = prompts.get(promptProfile);
    if (system === undefined) {
      throw new Error(`picks[${String(index)}]: no system prompt for "${promptProfile}"`);
    }
    const { messages, ...rest } = isRecord(raw) ? raw : {};
    if (!Array.isArray(messages)) throw new Error(`picks[${String(index)}]: "messages" missing`);
    const turns: readonly unknown[] = messages;
    if (turns.some((message) => isRecord(message) && message.role === "system")) {
      throw new Error(`picks[${String(index)}]: the system prompt is added here, not in the pick`);
    }
    const { id, stage, label } = rest;
    return { id, stage, label, messages: [{ role: "system", content: system }, ...turns] };
  });
  return parseCases(withSystem);
};
