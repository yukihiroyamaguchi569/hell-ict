import { afterEach, describe, expect, it, vi } from "vitest";

import { browserClipboard } from "../src/browser-ports.js";

/*
 * The browser clipboard with a fake `navigator` and `document`: the async API refuses, so the
 * hidden-textarea fallback runs, and what `execCommand("copy")` answers decides the outcome.
 */

interface FakeTextarea {
  value: string;
  style: Record<string, string>;
  selected: boolean;
  removed: boolean;
  focus(): void;
  select(): void;
  remove(): void;
}

let selectThrows = false;

const fakeTextarea = (): FakeTextarea => ({
  value: "",
  style: {},
  selected: false,
  removed: false,
  focus() {},
  select() {
    if (selectThrows) throw new Error("InvalidStateError");
    this.selected = true;
  },
  remove() {
    this.removed = true;
  },
});

const setup = (execCommand: () => boolean, asyncWrite?: (text: string) => Promise<void>) => {
  const areas: FakeTextarea[] = [];
  const copied: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: asyncWrite ?? (() => Promise.reject(new Error("NotAllowedError"))),
    },
  });
  vi.stubGlobal("document", {
    createElement: () => {
      const area = fakeTextarea();
      areas.push(area);
      return area;
    },
    body: { appendChild: () => undefined },
    execCommand: () => {
      const area = areas.at(-1);
      if (area?.selected === true) copied.push(area.value);
      return execCommand();
    },
  });
  return { areas, copied };
};

afterEach(() => {
  selectThrows = false;
  vi.unstubAllGlobals();
});

describe("browserClipboard", () => {
  it("非同期 API が書ければそれで終わり、textarea は作らない", async () => {
    const written: string[] = [];
    const { areas } = setup(
      () => true,
      (text) => {
        written.push(text);
        return Promise.resolve();
      },
    );
    await expect(browserClipboard.writeText("本文")).resolves.toBeUndefined();
    expect(written).toEqual(["本文"]);
    expect(areas).toHaveLength(0);
  });

  it("非同期 API が拒んだら textarea + execCommand で書き、後始末する", async () => {
    const { areas, copied } = setup(() => true);
    await expect(browserClipboard.writeText("本文")).resolves.toBeUndefined();
    expect(copied).toEqual(["本文"]);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.removed).toBe(true);
  });

  it("execCommand が false を返したら失敗として拒む（textarea は後始末する）", async () => {
    const { areas } = setup(() => false);
    await expect(browserClipboard.writeText("本文")).rejects.toThrow();
    expect(areas[0]?.removed).toBe(true);
  });

  it("execCommand が投げても拒み、textarea は後始末する", async () => {
    const { areas } = setup(() => {
      throw new Error("SecurityError");
    });
    await expect(browserClipboard.writeText("本文")).rejects.toThrow("SecurityError");
    expect(areas[0]?.removed).toBe(true);
  });

  it("navigator.clipboard が無い（非セキュアな文脈）ときも textarea で書く", async () => {
    const { copied } = setup(() => true);
    vi.stubGlobal("navigator", {});
    await expect(browserClipboard.writeText("本文")).resolves.toBeUndefined();
    expect(copied).toEqual(["本文"]);
  });

  it("select が投げても拒み、textarea は後始末する", async () => {
    const { areas } = setup(() => true);
    selectThrows = true;
    await expect(browserClipboard.writeText("本文")).rejects.toThrow("InvalidStateError");
    expect(areas).toHaveLength(1);
    expect(areas[0]?.removed).toBe(true);
  });
});
