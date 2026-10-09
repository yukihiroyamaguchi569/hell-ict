import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makePrivateDir, writePrivateFile } from "./files.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modeOf = (target: string): number => statSync(target).mode & 0o777;
const fresh = (): string => mkdtempSync(path.join(os.tmpdir(), "ai-bench-files-"));

describe("writePrivateFile", () => {
  it("writes a new file readable by the owner only", async () => {
    const file = path.join(fresh(), "report.html");
    await writePrivateFile(file, "x");
    expect(modeOf(file)).toBe(0o600);
  });

  it("tightens a file that already existed with wider permissions", async () => {
    const file = path.join(fresh(), "bench.json");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    await writePrivateFile(file, "new");
    expect(modeOf(file)).toBe(0o600);
    expect(statSync(file).size).toBe(3);
  });
});

describe("writePrivateFile replaces instead of rewriting in place", () => {
  it("never puts the new content into the old, readable file", async () => {
    const file = path.join(fresh(), "report.html");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    // Whoever had the old file open (with its old permissions) must not see the new content.
    const oldFile = openSync(file, "r");
    try {
      await writePrivateFile(file, "secret");
      expect(readFileSync(oldFile, "utf8")).toBe("old");
    } finally {
      closeSync(oldFile);
    }
    expect(readFileSync(file, "utf8")).toBe("secret");
    expect(modeOf(file)).toBe(0o600);
  });

  it("leaves no temporary file behind, on success or on failure", async () => {
    const dir = fresh();
    await writePrivateFile(path.join(dir, "ok.json"), "x");
    mkdirSync(path.join(dir, "taken"));
    writeFileSync(path.join(dir, "taken", "keep"), "");
    await expect(writePrivateFile(path.join(dir, "taken"), "x")).rejects.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["ok.json", "taken"]);
  });
});

describe("makePrivateDir", () => {
  it("sets every folder it makes to 700", async () => {
    const base = fresh();
    const dir = path.join(base, "a", "b", "c");
    await makePrivateDir(dir);
    for (const made of ["a", "a/b", "a/b/c"]) expect(modeOf(path.join(base, made))).toBe(0o700);
  });

  it("leaves a folder that already existed alone", async () => {
    const dir = fresh();
    chmodSync(dir, 0o755);
    await makePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o755);
    const child = path.join(dir, "new");
    await makePrivateDir(child);
    expect(modeOf(dir)).toBe(0o755);
    expect(modeOf(child)).toBe(0o700);
  });
});

describe("build-cases-main (as a process)", () => {
  it("leaves the cases file readable by the owner only, also when it already existed", () => {
    const dir = fresh();
    const prompts = path.join(dir, "prompts.mjs");
    writeFileSync(prompts, 'export const systemPrompts = { default: "SYS" };');
    const picks = path.join(dir, "picks.json");
    writeFileSync(
      picks,
      JSON.stringify([
        { id: "a", stage: "s4", label: "l", messages: [{ role: "user", content: "q" }] },
      ]),
    );
    const out = path.join(dir, "cases.json");
    writeFileSync(out, "[]");
    chmodSync(out, 0o644);
    const result = spawnSync(
      process.execPath,
      [
        path.join(HERE, "build-cases-main.ts"),
        "--prompts",
        prompts,
        "--picks",
        picks,
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(modeOf(out)).toBe(0o600);
  });
});
