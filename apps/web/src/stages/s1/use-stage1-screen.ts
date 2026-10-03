import { stage1Memo, stage1MemoText, stage1ScreenText } from "@hell-ict/content";
import type { Mail } from "@hell-ict/content";
import { stage1MailIdSchema } from "@hell-ict/domain";
import type { Stage1MailId } from "@hell-ict/domain";
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { ClipboardPort } from "../../ports.js";
import type { StageContext } from "../stage-module.js";
import { stage1MailText } from "./s1-view.js";
import {
  stage1CenterMode,
  stage1ClearWindow,
  stage1LogAfter,
  stage1RoundEnd,
  stage1ShouldClose,
} from "./s1-screen.js";
import type { Stage1CenterMode, Stage1ClearWindow, Stage1RoundEnd } from "./s1-screen.js";
import type { Stage1, Stage1Press } from "./use-stage1.js";
import type { Stage1Draft } from "./use-stage1-draft.js";

/** How long a button shows 「本文が空です」 or 「コピーしました」 (the mock's 1600 ms). */
export const STAGE1_FLASH_MS = 1_600;

/** When each beat of the briefing comes up (the mock's BRIEF_BEATS): portrait, six says, notice, button. */
export const STAGE1_BRIEF_BEATS = [0, 400, 1200, 2000, 2800, 3600, 4300, 4700, 5300] as const;

export interface Stage1ScreenDeps {
  readonly context: StageContext;
  readonly stage: Stage1;
  readonly draft: Stage1Draft;
  readonly clipboard: ClipboardPort;
}

export interface Stage1Screen {
  readonly mode: ComputedRef<Stage1CenterMode>;
  /** The open mail of the round, or `null` (the memo is `mode === "memo"`). */
  readonly mailId: ComputedRef<Stage1MailId | null>;
  readonly mail: ComputedRef<Mail | null>;
  /** R2 on: the context box, the key points and the draft button. */
  readonly aiReady: ComputedRef<boolean>;
  readonly roundEnd: ComputedRef<Stage1RoundEnd | null>;
  /**
   * The clear's window while it is up: cleared, and ［確認した（次へ）］ not pressed yet. The
   * press is not kept, so a reload into the cleared stage shows the window again (HANDOFF
   * 2026-09-27, decision 3). The frame holds the clear effect back while it is up.
   */
  readonly clearWindow: ComputedRef<Stage1ClearWindow | null>;
  /** 「返信した」「時間切れ」, newest first. In memory only: a reload starts it empty. */
  readonly log: Readonly<Ref<readonly string[]>>;
  readonly sendLabel: ComputedRef<string>;
  readonly copyLabel: ComputedRef<string>;
  /** The briefing's beats shown so far (all of them: the button can be pressed). */
  readonly beats: Readonly<Ref<number>>;
  /** A command of the windows is on its way: their button waits. */
  readonly busy: Readonly<Ref<boolean>>;
  send(): Promise<void>;
  copyMemo(): Promise<void>;
  showAllBeats(): void;
  begin(): Promise<void>;
  nextRound(): Promise<void>;
  /** Closes the clear's window: the frame's clear effect starts. */
  closeClearWindow(): void;
}

/**
 * The screen's side of Stage 1: which mail is open (closed when it stops being live), the log,
 * the buttons' passing words and the briefing's beats. What is sent and kept is `useStage1` and
 * `useStage1Draft`'s.
 */
export const useStage1Screen = (deps: Stage1ScreenDeps): Stage1Screen => {
  const { context, stage, draft } = deps;
  const { mail: selection, scheduler } = context;
  const log = shallowRef<readonly string[]>([]);
  const flash = shallowRef<{ key: "send" | "copy"; text: string } | null>(null);
  const beats = shallowRef(0);
  const busy = shallowRef(false);
  const clearClosed = shallowRef(false);
  let cancelFlash = (): void => undefined;
  const cancelBeats: (() => void)[] = [];
  onScopeDispose(() => {
    cancelFlash();
    cancelBeats.forEach((cancel) => {
      cancel();
    });
  });

  const openId = computed(() => selection.openId.value);
  const mode = computed(() => stage1CenterMode(stage.state.value, stage.rows.value, openId.value));
  const mailId = computed(() => {
    const parsed = stage1MailIdSchema.safeParse(openId.value);
    return mode.value === "mail" && parsed.success ? parsed.data : null;
  });

  watch(
    () => stage.rows.value,
    (after, before) => {
      if (stage1ShouldClose(after, openId.value)) selection.close();
      log.value = stage1LogAfter(log.value, before, after);
    },
  );

  const clearWindow = computed(() =>
    clearClosed.value ? null : stage1ClearWindow(stage.state.value),
  );
  // The window sounds as it comes up (mock s1ShowResultWin); the clear effect's ① does not
  // (clearSheets' `sfx` is null for Stage 1). A reload shows the window, and sounds, again.
  watch(
    () => clearWindow.value !== null,
    (open) => {
      if (open) context.sfx.play("success1");
    },
    { immediate: true },
  );

  const showFlash = (key: "send" | "copy", text: string): void => {
    cancelFlash();
    flash.value = { key, text };
    cancelFlash = scheduler.schedule(() => {
      flash.value = null;
    }, STAGE1_FLASH_MS);
  };
  const labelOf = (key: "send" | "copy", idle: string): string =>
    flash.value?.key === key ? flash.value.text : idle;

  // The briefing comes up beat by beat until the stage has started.
  watch(
    () => stage.state.value === null,
    (waiting) => {
      if (!waiting) return;
      beats.value = 0;
      STAGE1_BRIEF_BEATS.forEach((at, i) => {
        cancelBeats.push(
          scheduler.schedule(() => {
            beats.value = Math.max(beats.value, i + 1);
          }, at),
        );
      });
    },
    { immediate: true },
  );

  /** Replies to what is open: the memo, or the round's mail. */
  const sendOpen = async (): Promise<Stage1Press | null> => {
    if (mode.value === "memo") return stage.replyToMemo(draft.memo.value);
    const id = mailId.value;
    return id === null ? null : stage.reply(id, draft.body(id));
  };

  const once = async (press: () => Promise<unknown>): Promise<void> => {
    if (busy.value) return;
    busy.value = true;
    try {
      await press();
    } finally {
      busy.value = false;
    }
  };

  return {
    mode,
    mailId,
    mail: computed(() => {
      if (mode.value === "memo") return stage1Memo;
      return mailId.value === null ? null : stage1MailText(mailId.value);
    }),
    aiReady: computed(() => (stage.state.value?.round ?? 1) > 1),
    roundEnd: computed(() => {
      const s1 = stage.state.value;
      return s1 === null ? null : stage1RoundEnd(s1, context.serverNow.value);
    }),
    clearWindow,
    log,
    sendLabel: computed(() => labelOf("send", stage1ScreenText.send)),
    copyLabel: computed(() => labelOf("copy", stage1ScreenText.copy)),
    beats,
    busy,
    async send() {
      const press = await sendOpen();
      if (press?.kind === "empty") showFlash("send", stage1ScreenText.empty);
    },
    async copyMemo() {
      try {
        await deps.clipboard.writeText(stage1MemoText);
        showFlash("copy", stage1ScreenText.copied);
      } catch {
        // Nothing more to do: the same text is in the shared folder's viewer.
      }
    },
    showAllBeats() {
      beats.value = STAGE1_BRIEF_BEATS.length;
    },
    begin: () => once(() => stage.start()),
    nextRound: () => once(() => stage.nextRound()),
    closeClearWindow() {
      clearClosed.value = true;
    },
  };
};
