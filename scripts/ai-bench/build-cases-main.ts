import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildCases, parseSystemPrompts } from "./build-cases.ts";
import { assertOutsideRepo } from "./cli.ts";

/**
 * `node scripts/ai-bench/build-cases-main.ts --prompts <prompts.ts> --picks <picks.json> --out <cases.json>`
 *
 * How to make the cases (the real prompts and the participants' text never enter this repo):
 * 1. Read the participants' messages of the event from the production D1 (SELECT only), e.g.
 *    `pnpm exec wrangler d1 execute <db> --remote --json --command "SELECT ... FROM activity_events
 *    WHERE event_id='<event>' AND kind IN ('chat.user','chat.assistant') ..."` in apps/worker.
 *    The stage of a message is the `title` of its thread's `thread.create` row ("Stage 3", ...;
 *    no row means the main conversation, Stage 1). `meta.promptProfile` is the profile it used.
 * 2. Write the chosen ones, outside the repository, as picks: a JSON array of
 *    {id, stage, label, promptProfile, messages: [{role: "user" | "assistant", content}]}, the
 *    last message being the participant's. Check by eye that no name or number of a person is left.
 * 3. Run this with `--prompts` pointing at the scenario repo's packages/content/src/prompts.ts.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      prompts: { type: "string" },
      picks: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.prompts === undefined || values.picks === undefined || values.out === undefined) {
    throw new Error("--prompts, --picks and --out are required");
  }
  const outFile = path.resolve(values.out);
  assertOutsideRepo(outFile, REPO_ROOT);
  const moduleExports: unknown = await import(pathToFileURL(path.resolve(values.prompts)).href);
  const picks: unknown = JSON.parse(await readFile(values.picks, "utf8"));
  const cases = buildCases(picks, parseSystemPrompts(moduleExports));
  await writeFile(outFile, JSON.stringify(cases, null, 2), { mode: 0o600 });
  console.log(`${String(cases.length)} cases written to ${outFile}`);
};

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
});
