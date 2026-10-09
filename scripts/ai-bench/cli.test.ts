import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BenchCase } from "./cases.ts";
import {
  assertOutsideRepo,
  dryRunLines,
  parseCliArgs,
  providersOf,
  resolveOutDir,
  USAGE,
} from "./cli.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

describe("parseCliArgs", () => {
  it("uses the four models and the defaults", () => {
    const options = parseCliArgs(["--cases", "c.json"]);
    expect(options.models.map((model) => model.name)).toEqual([
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-6-sol",
    ]);
    expect(options).toMatchObject({
      casesPath: "c.json",
      repeat: 1,
      concurrency: 2,
      timeoutMs: 60_000,
      out: null,
      dryRun: false,
    });
  });

  it("takes the model list, trimming and de-duplicating it; an unknown model has no price", () => {
    const options = parseCliArgs([
      "--cases",
      "c",
      "--models",
      " gpt-4.1 ,gpt-x,,gpt-4.1",
      "--provider",
      "openai",
    ]);
    expect(options.models).toEqual([
      { name: "gpt-4.1", provider: "openai", params: {}, price: { input: 2, output: 8 } },
      { name: "gpt-x", provider: "openai", params: {}, price: null },
    ]);
  });

  it("mixes providers, each model bringing its own", () => {
    const options = parseCliArgs([
      "--cases",
      "c",
      "--models",
      "gpt-4.1-mini,gemini-3.8-flash,claude-haiku-4-5-20251001,claude-sonnet-5-5",
    ]);
    expect(options.models.map((model) => [model.name, model.provider])).toEqual([
      ["gpt-4.1-mini", "openai"],
      ["gemini-3.8-flash", "gemini"],
      ["claude-haiku-4-5-20251001", "anthropic"],
      ["claude-sonnet-5-5", "anthropic"],
    ]);
    expect(providersOf(options.models)).toEqual(["openai", "gemini", "anthropic"]);
  });

  it("sends a model not in config.ts to --provider, leaving the known ones where they are", () => {
    const options = parseCliArgs([
      "--cases",
      "c",
      "--models",
      "gemini-9-flash,gpt-4o",
      "--provider",
      " gemini ",
    ]);
    expect(options.models.map((model) => [model.name, model.provider, model.price])).toEqual([
      ["gemini-9-flash", "gemini", null],
      ["gpt-4o", "openai", { input: 2.5, output: 10 }],
    ]);
  });

  it("refuses a model not in config.ts without --provider, rather than guessing from its name", () => {
    expect(() => parseCliArgs(["--cases", "c", "--models", "gemini-9-flash"])).toThrow(
      /"gemini-9-flash" is not in config.ts: pass --provider/,
    );
  });

  it.each([["azure"], [""], ["OpenAI"]])("rejects --provider %j", (value) => {
    expect(() => parseCliArgs(["--cases", "c", "--provider", value])).toThrow(
      /--provider must be one of openai, gemini, anthropic/,
    );
  });

  it("explains in --help where each provider's key comes from and how to enter it", () => {
    for (const text of [
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "ANTHROPIC_API_KEY",
      "read -s GEMINI_API_KEY && export GEMINI_API_KEY",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "https://api.anthropic.com/v1",
      "--models gpt-4.1-mini,gemini-3.8-flash,claude-haiku-5-5",
    ]) {
      expect(USAGE).toContain(text);
    }
  });

  it("takes repeat, concurrency, timeout, out and dry-run", () => {
    const options = parseCliArgs([
      "--cases=c",
      "--repeat=3",
      "--concurrency",
      "1",
      "--timeout-ms",
      "30000",
      "--out",
      "/tmp/x",
      "--dry-run",
    ]);
    expect(options).toMatchObject({
      repeat: 3,
      concurrency: 1,
      timeoutMs: 30_000,
      out: "/tmp/x",
      dryRun: true,
    });
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"], [""]])("rejects --repeat %j", (value) => {
    expect(() => parseCliArgs(["--cases", "c", "--repeat", value])).toThrow(/--repeat/);
  });

  it("requires --cases unless asking for help", () => {
    expect(() => parseCliArgs([])).toThrow(/--cases is required/);
    expect(parseCliArgs(["--help"]).help).toBe(true);
  });

  it("rejects an empty model list", () => {
    expect(() => parseCliArgs(["--cases", "c", "--models", " , "])).toThrow(/at least one/);
  });

  it("refuses an API key on the command line", () => {
    expect(() => parseCliArgs(["--cases", "c", "--api-key", "sk-x"])).toThrow();
  });
});

describe("resolveOutDir", () => {
  const context = { repoRoot: "/work/repo", tmpDir: "/tmp/t", stamp: "S" };

  it("defaults to a fresh folder under the temp dir", () => {
    expect(resolveOutDir(null, context)).toBe("/tmp/t/hell-ict-ai-bench/S");
  });

  it("accepts a folder outside the repository, including a sibling with a similar name", () => {
    expect(resolveOutDir("/work/repo-out", context)).toBe("/work/repo-out");
  });

  it.each([["/work/repo"], ["/work/repo/out"], ["/work/repo/a/../b"]])(
    "refuses %s inside the repository",
    (out) => {
      expect(() => resolveOutDir(out, context)).toThrow(/outside the repository/);
    },
  );

  it("refuses a file inside the repository", () => {
    expect(() => {
      assertOutsideRepo("/work/repo/cases.json", "/work/repo");
    }).toThrow(/outside the repository/);
  });
});

describe("assertOutsideRepo with symbolic links", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ai-bench-link-"));
  const repo = path.join(base, "repo");
  mkdirSync(path.join(repo, "sub"), { recursive: true });
  const outside = path.join(base, "outside");
  mkdirSync(outside);
  symlinkSync(repo, path.join(base, "link-to-repo"));
  symlinkSync(path.join(repo, "sub"), path.join(outside, "link-to-sub"));
  symlinkSync(path.join(repo, "gone"), path.join(base, "dangling"));
  symlinkSync(outside, path.join(repo, "link-out"));

  it.each([
    ["a link to the repository", "link-to-repo"],
    ["a folder not made yet under a link to the repository", "link-to-repo/new/deeper"],
    ["a file under a link to a folder of the repository", "outside/link-to-sub/cases.json"],
  ])("refuses %s", (_name, target) => {
    expect(() => {
      assertOutsideRepo(path.join(base, target), repo);
    }).toThrow(/outside the repository/);
  });

  it("refuses a dangling link, which could point anywhere", () => {
    expect(() => {
      assertOutsideRepo(path.join(base, "dangling"), repo);
    }).toThrow(/cannot resolve/);
  });

  it("accepts a real folder outside, also when reached through a link inside the repository", () => {
    expect(() => {
      assertOutsideRepo(path.join(outside, "new"), repo);
      assertOutsideRepo(path.join(repo, "link-out", "x"), repo);
    }).not.toThrow();
  });

  it("refuses a repository given through a link, too", () => {
    expect(() => {
      assertOutsideRepo(path.join(repo, "out"), path.join(base, "link-to-repo"));
    }).toThrow(/outside the repository/);
  });
});

describe("dryRunLines", () => {
  const cases: BenchCase[] = [
    {
      id: "s3-short",
      stage: "s3",
      label: "short question",
      messages: [
        { role: "system", content: "あいう" },
        { role: "user", content: "abcdefgh" },
      ],
    },
  ];

  it("lists the models with their parameters and the size of each case", () => {
    const lines = dryRunLines(cases, parseCliArgs(["--cases", "c", "--repeat", "2"]));
    expect(lines).toContain(
      'model gpt-6-sol (openai, key OPENAI_API_KEY) params {"reasoning_effort":"none"}',
    );
    expect(lines).toContain("s3-short [s3] short question: 2 messages, 11 chars, ~13 tokens");
    expect(lines).toContain("2 calls per model, 8 in all, ~26 input tokens per model");
    expect(lines.some((line) => line.startsWith("gpt-4o: input ~$"))).toBe(true);
  });

  it("shows an unknown price as unknown", () => {
    const lines = dryRunLines(
      cases,
      parseCliArgs(["--cases", "c", "--models", "gpt-x", "--provider", "openai"]),
    );
    expect(lines.at(-1)).toBe("gpt-x: input ~不明 (output not included)");
  });

  it("names each model's provider, key variable and parameters", () => {
    const lines = dryRunLines(
      cases,
      parseCliArgs(["--cases", "c", "--models", "gemini-3.8-flash,claude-sonnet-5-5"]),
    );
    expect(lines).toContain(
      'model gemini-3.8-flash (gemini, key GEMINI_API_KEY) params {"reasoning_effort":"minimal"}',
    );
    expect(lines).toContain(
      'model claude-sonnet-5-5 (anthropic, key ANTHROPIC_API_KEY) params {"thinking":{"type":"between_tools"}}',
    );
  });
});

describe("main (as a process)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-bench-test-"));
  const casesPath = path.join(dir, "cases.json");
  writeFileSync(
    casesPath,
    JSON.stringify([
      { id: "a", stage: "s4", label: "l", messages: [{ role: "user", content: "q" }] },
    ]),
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(HERE, "main.ts"), ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // No OPENAI_API_KEY from the developer's shell, and nowhere real to send to.
      env: { PATH: process.env.PATH ?? "", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", ...env },
    });

  it("reads the case file in a dry run, without a key", () => {
    const result = run(["--cases", casesPath, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("a [s4] l: 1 messages");
  });

  it("stops before calling anything when the key is missing", () => {
    const result = run(["--cases", casesPath, "--out", path.join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_API_KEY is not set");
    expect(result.stderr).not.toContain("[1/");
  });

  it("asks only for the keys of the providers in use, all missing ones at once", () => {
    const result = run(
      [
        "--cases",
        casesPath,
        "--models",
        "gpt-4.1-mini,gemini-3.8-flash,claude-haiku-5-5",
        "--out",
        path.join(dir, "out-mixed"),
      ],
      { OPENAI_API_KEY: "sk-test-openai-set" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GEMINI_API_KEY, ANTHROPIC_API_KEY are not set");
    expect(result.stderr).not.toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain("sk-test-openai-set");
    expect(result.stderr).not.toContain("[1/");
  });

  it("does not ask for the keys of providers not in use", () => {
    const result = run(
      ["--cases", casesPath, "--models", "gemini-3.8-flash", "--out", path.join(dir, "out-g")],
      { GEMINI_API_KEY: "AIza-test-not-used", GEMINI_BASE_URL: "http://127.0.0.1:9/v1" },
    );
    // Port 9 refuses the connection: the call is recorded as a network error and the run ends.
    expect(result.stderr).toContain("gemini-3.8-flash (gemini) a #1");
    expect(result.stderr).not.toContain("is not set");
    expect(result.stderr).not.toContain("AIza-test-not-used");
  });

  it("refuses an output folder inside the repository before calling anything", () => {
    const result = run(["--cases", casesPath, "--out", path.join(REPO_ROOT, "tmp-out")], {
      OPENAI_API_KEY: "sk-test-not-used",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
    expect(result.stderr).not.toContain("sk-test-not-used");
  });

  it("stops on a malformed case file", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ id: "a" }]));
    const result = run(["--cases", bad, "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"stage" must be a non-empty string');
  });
});
