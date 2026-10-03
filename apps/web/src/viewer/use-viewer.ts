import type { ViewerId } from "@hell-ict/content";
import { computed, inject, onScopeDispose, provide, ref } from "vue";
import type { ComputedRef, InjectionKey } from "vue";

import type { ClipboardPort, Scheduler } from "../ports.js";
import {
  allColumnsPicked,
  COPIED_MS,
  NO_COLUMNS_MS,
  selectedColumnsText,
  toggleColumn,
  VIEWER_LABELS,
  viewerSheet,
  type ViewerSheet,
} from "./viewer-view.js";

/*
 * The attachment viewer's state (mock #ov-viewer): which document is open, the columns picked,
 * and the labels the copy buttons wear for a moment after a click. One viewer for the whole
 * screen; the shared folder opens it now, mail attachments will call `open(id)` too.
 */

export interface ViewerDeps {
  readonly clipboard: ClipboardPort;
  readonly scheduler: Scheduler;
}

export interface Viewer {
  readonly openId: ComputedRef<ViewerId | null>;
  readonly sheet: ComputedRef<ViewerSheet | null>;
  /** One flag per table column; empty for a document without a table. */
  readonly picked: ComputedRef<readonly boolean[]>;
  readonly copyLabel: ComputedRef<string>;
  readonly columnsLabel: ComputedRef<string>;
  open(id: ViewerId): void;
  close(): void;
  toggleColumn(index: number): void;
  copyAll(): void;
  copyColumns(): void;
}

/**
 * A button label that shows `text` for a while and then goes back to its resting label.
 * Every click is a request with its own number; only the latest request may change the label,
 * so an answer that comes back late (a clipboard write that took its time) never overwrites
 * what a later click, or a reset, put there.
 */
const useFlashLabel = (scheduler: Scheduler, resting: string) => {
  const label = ref(resting);
  let latest = 0;
  let cancel: () => void = () => undefined;
  const show = (text: string, delayMs: number): void => {
    cancel();
    label.value = text;
    cancel = scheduler.schedule(() => {
      label.value = resting;
    }, delayMs);
  };
  /** Starts a request; the function it returns shows its result, unless a newer one exists. */
  const request = (): ((text: string, delayMs: number) => void) => {
    latest += 1;
    const mine = latest;
    return (text, delayMs) => {
      if (mine === latest) show(text, delayMs);
    };
  };
  const reset = (): void => {
    latest += 1;
    cancel();
    label.value = resting;
  };
  return { label: computed(() => label.value), request, reset };
};

type FlashLabel = ReturnType<typeof useFlashLabel>;

export const useViewer = (deps: ViewerDeps): Viewer => {
  const openId = ref<ViewerId | null>(null);
  const picked = ref<readonly boolean[]>([]);
  const copyButton = useFlashLabel(deps.scheduler, VIEWER_LABELS.copy);
  const columnsButton = useFlashLabel(deps.scheduler, VIEWER_LABELS.copyColumns);
  const sheet = computed(() => (openId.value === null ? null : viewerSheet(openId.value)));

  /**
   * Says "copied" only once the clipboard has taken the text; a refusal says so instead, or the
   * team would paste nothing without knowing why (the mock claimed success either way).
   */
  const write = (text: string, button: FlashLabel): void => {
    const settle = button.request();
    deps.clipboard.writeText(text).then(
      () => {
        settle(VIEWER_LABELS.copied, COPIED_MS);
      },
      () => {
        settle(VIEWER_LABELS.copyFailed, COPIED_MS);
      },
    );
  };

  /** Both buttons start over: resting labels, no timer, and pending answers are ignored. */
  const resetButtons = (): void => {
    copyButton.reset();
    columnsButton.reset();
  };

  onScopeDispose(resetButtons);

  return {
    openId: computed(() => openId.value),
    sheet,
    picked: computed(() => picked.value),
    copyLabel: copyButton.label,
    columnsLabel: columnsButton.label,
    open(id) {
      openId.value = id;
      picked.value = allColumnsPicked(viewerSheet(id).table);
      resetButtons();
    },
    close() {
      openId.value = null;
      resetButtons();
    },
    toggleColumn(index) {
      picked.value = toggleColumn(picked.value, index);
    },
    copyAll() {
      const current = sheet.value;
      if (current === null || !current.copyable) return;
      write(current.text, copyButton);
    },
    copyColumns() {
      const table = sheet.value?.table ?? null;
      if (table === null) return;
      const text = selectedColumnsText(table, picked.value);
      if (text === null) {
        columnsButton.request()(VIEWER_LABELS.noColumns, NO_COLUMNS_MS);
        return;
      }
      write(text, columnsButton);
    },
  };
};

const VIEWER_KEY: InjectionKey<Viewer> = Symbol("viewer");

/** Shares the one viewer with every component below, so a mail can open its attachment. */
export const provideViewer = (viewer: Viewer): void => {
  provide(VIEWER_KEY, viewer);
};

export const injectViewer = (): Viewer => {
  const viewer = inject(VIEWER_KEY, null);
  if (viewer === null) throw new Error("provideViewer has not been called above.");
  return viewer;
};
