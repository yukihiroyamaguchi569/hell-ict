import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The output holds the real scenario and the participants' text, so only the owner may read it.
 * `mode` of writeFile/mkdir applies only to what they create, so the permissions are set
 * explicitly afterwards: an existing file is tightened too. A folder that already existed (say,
 * ~/Desktop) is left alone; only the folders made here are set to 700.
 */

export const makePrivateDir = async (dir: string): Promise<void> => {
  const first = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (first === undefined) return;
  // mkdir returns the topmost folder it made; every folder from there down to `dir` is new.
  const top = path.resolve(first);
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    await chmod(current, 0o700);
    if (current === top || path.dirname(current) === current) return;
  }
};

export const writePrivateFile = async (file: string, content: string): Promise<void> => {
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
};
