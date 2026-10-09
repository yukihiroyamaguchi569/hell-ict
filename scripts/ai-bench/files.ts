import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The output holds the real scenario and the participants' text, so only the owner may read it.
 * A file is written to a new temporary file (created 600, next to the target) and renamed over
 * the target, so an existing file is never rewritten in place under its old, wider permissions.
 * `mode` of mkdir applies only to what it creates, so the folders made here are set to 700
 * explicitly; a folder that already existed (say, ~/Desktop) is left alone.
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
  const target = path.resolve(file);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    // "wx": never reuse an existing file; the umask can only narrow 600, chmod makes it exact.
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (caught) {
    await rm(temporary, { force: true });
    throw caught;
  }
};
