import type {
  AddressBar,
  ClipboardPort,
  Clock,
  IdGenerator,
  ImagePreloader,
  KeyValueStorage,
  PreloadResult,
  ResumeSignal,
  Scheduler,
} from "./ports.js";

/** The browser's implementations of the ports (`ports.ts`). Tests use fakes instead. */

export const browserClock: Clock = { now: () => new Date() };

export const browserIds: IdGenerator = { next: () => crypto.randomUUID() };

/** `localStorage` is read on each call: touching it may itself throw (blocked site data). */
export const browserStorage: KeyValueStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
  },
};

/**
 * `sessionStorage`, for what may go when the tab closes (the chat's unconfirmed command ids).
 * Read on each call for the same reason as `browserStorage`.
 */
export const browserSessionStorage: KeyValueStorage = {
  getItem: (key) => sessionStorage.getItem(key),
  setItem: (key, value) => {
    sessionStorage.setItem(key, value);
  },
  removeItem: (key) => {
    sessionStorage.removeItem(key);
  },
};

/**
 * The old way: select a hidden textarea and run the copy command (the mock's s1CopyMemo).
 * Throws when the browser would not copy.
 */
const copyWithTextarea = (text: string): void => {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  // Everything after the textarea is in the page goes inside the try, so it is always removed.
  try {
    area.focus();
    area.select();
    // Deprecated, but the only way left where the Clipboard API is missing or refuses (plain
    // http, older browsers). It answers `false` instead of throwing when it would not copy.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- last-resort copy where the Clipboard API fails
    if (!document.execCommand("copy")) throw new Error("execCommand('copy') was refused.");
  } finally {
    area.remove();
  }
};

/** The Clipboard API first; the textarea fallback when it is missing or refuses. */
export const browserClipboard: ClipboardPort = {
  async writeText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Also where `navigator.clipboard` is absent (outside a secure context): reading
      // `writeText` of undefined throws into this same fallback.
      copyWithTextarea(text);
    }
  },
};

/** Keeps `history.state` so the replace changes nothing but the URL. */
export const browserAddressBar: AddressBar = {
  current: () => `${location.pathname}${location.search}${location.hash}`,
  replace(url) {
    history.replaceState(history.state, "", url);
  },
};

export const browserScheduler: Scheduler = {
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** The tab became visible again, or the network came back. */
export const browserResumeSignal: ResumeSignal = {
  subscribe(listener) {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", listener);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", listener);
    };
  },
};

/**
 * Asks `load` once per src: a src loaded or on its way gets the same answer, a src that failed is
 * loaded again on the next call (a later preload, or a retry when the network comes back).
 */
export const loadOncePerSrc = (load: (src: string) => Promise<PreloadResult>): ImagePreloader => {
  const known = new Map<string, Promise<PreloadResult>>();
  return {
    preload(src) {
      const asked = known.get(src);
      if (asked !== undefined) return asked;
      const loading = load(src).then((result) => {
        if (result === "failed") known.delete(src);
        return result;
      });
      known.set(src, loading);
      return loading;
    },
  };
};

/** Images on their way, held until they settle so nothing collects them before the fetch ends. */
const preloading = new Set<HTMLImageElement>();

const loadImage = (src: string): Promise<PreloadResult> =>
  new Promise((resolve) => {
    const image = new Image();
    const settle = (result: PreloadResult): void => {
      preloading.delete(image);
      resolve(result);
    };
    image.addEventListener(
      "load",
      () => {
        settle("loaded");
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        settle("failed");
      },
      { once: true },
    );
    preloading.add(image);
    image.src = src;
  });

export const browserImagePreloader: ImagePreloader = loadOncePerSrc(loadImage);
