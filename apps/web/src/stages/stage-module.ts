import type { ViewerId } from "@hell-ict/content";
import type { GameStageId, TeamGameViewState } from "@hell-ict/domain";
import type { Component, Ref } from "vue";

import type { ChatSubmit, ScriptedChat } from "../chat/use-scripted-chat.js";
import type { GameSession } from "../composables/use-game-session.js";
import type { Sfx } from "../composables/use-sfx.js";
import type { KeyValueStorage, Scheduler } from "../ports.js";
import type { MissionDeadline, StageFocus } from "../shell/mission-bar-view.js";
import type { RightPane } from "../shell/shell-view.js";

/*
 * How a stage plugs into the common frame. Each stage's PR fills in its own
 * `stages/<id>/index.ts`; the registry, App.vue and the shell take whatever is there, so no
 * stage needs to touch them. A stage without a module shows 「この先は準備中です」 and sends
 * nothing.
 */

/** Which mail the centre pane has open. The frame empties it whenever the stage changes. */
export interface MailSelection {
  readonly openId: Readonly<Ref<string | null>>;
  open(id: string): void;
  close(): void;
}

/** What a stage is built with when the team enters it. */
export interface StageContext {
  readonly session: GameSession;
  /** The server's time, redrawn every 250 ms (`useServerNow`). */
  readonly serverNow: Readonly<Ref<number>>;
  /** For `sessionRecord` (drafts, what has been read): gone when the tab closes. */
  readonly sessionStorage: KeyValueStorage;
  readonly scheduler: Scheduler;
  /** The mail the centre reads: inbox rows that open `{ kind: "center" }` put their id here. */
  readonly mail: MailSelection;
  /** The stage's own sounds (a rejection's `cancel`). 苅部さん's ring is the frame's. */
  readonly sfx: Sfx;
  /** The `KarubeCall.callId`s the team has opened, kept across reloads (Stage 2 waits for one). */
  readonly karubeRead: Readonly<Ref<ReadonlySet<string>>>;
  /** The team's name kept on this PC (`useTeamName`; "" while unknown). */
  readonly teamName: Readonly<Ref<string>>;
}

/**
 * What pressing an inbox row does, after the frame has marked it read:
 * - center: the centre pane reads it (`StageContext.mail.openId`; the stage draws `MailReader`
 *   or a reply form of its own).
 * - viewer: the attachment viewer opens `doc`.
 * - stage: the stage's own `StageInbox.onOpen`.
 */
export type InboxOpen =
  | { readonly kind: "center" }
  | { readonly kind: "viewer"; readonly doc: ViewerId }
  | { readonly kind: "stage" };

/** The countdown under a row (mock `.mail .due`). */
export interface InboxDue {
  readonly text: string;
  /** How much of the bar is left, 0〜1, or `null` for the text alone (返信済み, 時間切れ). */
  readonly ratio: number | null;
  /** The warning colour of the last seconds. */
  readonly hot: boolean;
}

/** A row of the inbox in the left pane. The id is the row's key: the same mail, the same id. */
export interface InboxRow {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  /** The attachment's file name, shown in full (mock `.attach`). */
  readonly attach?: string;
  readonly opens: InboxOpen;
  /** Stays on top with the accent line (Stage 1's handover memo). */
  readonly pinned?: boolean;
  readonly due?: InboxDue;
  /** Replied or past its deadline: greyed out, and it no longer opens. */
  readonly closed?: boolean;
  /**
   * Counted in the heading's badge. Absent: until the row is opened or closed. Stage 1 counts
   * every mail still waiting for a reply, opened or not.
   */
  readonly unread?: boolean;
}

/** The stage's inbox. A stage without one leaves the inbox pane empty. */
export interface StageInbox {
  /** May be recomputed every tick: rows are drawn by id and patched, never rebuilt. */
  readonly rows: Readonly<Ref<readonly InboxRow[]>>;
  /** For rows that open `{ kind: "stage" }`. */
  readonly onOpen?: (id: string) => void;
}

/** A call from 苅部さん: it rings once per `callId`, and opening shows the lines one by one. */
export interface KarubeCall {
  readonly callId: string;
  readonly lines: readonly string[];
}

/**
 * A stage on screen: built by `StageModule.setup` in its own effect scope when the team enters
 * the stage, and dropped (the scope stopped) when it leaves. The components are the stage's own,
 * already bound to whatever `setup` made, so App.vue draws them without knowing their props.
 */
export interface StageInstance {
  /** The centre pane, under the mission bar. */
  readonly center: Component;
  /** The stage's windows, drawn in the overlay host's `stage` layer while `overlayWanted`. */
  readonly overlay?: Component;
  readonly overlayWanted?: Readonly<Ref<boolean>>;
  /** What the centre has open (the mission bar shows the Prologue's time only with a mail open). */
  readonly focus?: Readonly<Ref<StageFocus>>;
  /** The stage's say over the right pane, or `null` for the frame's default. */
  readonly rightPane?: Readonly<Ref<RightPane | null>>;
  /** The inbox in the left pane. */
  readonly inbox?: StageInbox;
  /**
   * The calls from 苅部さん that should have rung by now, oldest first (`[]` for none). A list,
   * not the latest one: two calls may come close together (Stage 1's 「やり直しの声」 and its
   * hint), and a reload must still ring and show both.
   */
  readonly karube?: Readonly<Ref<readonly KarubeCall[]>>;
  /**
   * The stage's buttons in the shared viewer's toolbar for the document open there (Stage 2's
   * ［表に追加］ on the addendum), or `null` for none.
   */
  readonly viewerToolbar?: (doc: ViewerId) => Component | null;
  /**
   * Replaces sending from the right pane's chat (Stage 2 and Stage 6 answer from a script:
   * `ChatPane`'s `onSubmit`). It returns the answer, which the pane shows after a pause and keeps
   * in memory only. Absent: the input sends to the server's AI as before.
   */
  readonly chatSubmit?: ChatSubmit;
  /**
   * The stage's own conversation in the right pane (Stage 6: its turns come from the server's
   * state, so a reload draws them again). `ChatPane` draws `turns` and hands the input to `send`
   * instead of `chatSubmit` or the server's AI. A turn waits with its `waitingText` while `reply`
   * is `null`; a reply may carry an `image`.
   */
  readonly chat?: ScriptedChat;
  /**
   * While true, the frame holds back the clear effect: it does not start, and the stage's window
   * (`overlay`) is on top instead (Stage 1's result window, before the common effect), shown
   * even if `overlayWanted` is false. A stage without `overlay` is never held (the team would be
   * left with nothing to press), so its effect plays as usual. When it
   * turns false the effect starts from ①; turning true again mid-effect drops the effect, which
   * starts over from ① when released. Derive it with `computed` from the state (not set in a
   * `watch`), so that the clear and the hold arrive in the same tick and the effect never
   * flashes. A reload into a cleared stage holds only if the stage says so from the start.
   * Absent: the effect plays as soon as the stage is cleared.
   */
  readonly holdClear?: Readonly<Ref<boolean>>;
  /**
   * While true, the frame holds back the clear effect with the centre left on screen (Stage 2's
   * verdict ticking its checks after a pass). No window of its own, so the stage must release
   * it on a timer of its own: it is a pause of a moment, never something to answer. Derive it
   * like `holdClear` so that the clear never flashes before it, and keep it false on a reload
   * into a cleared stage (the effect then plays at once). Absent: never paused.
   */
  readonly pauseClear?: Readonly<Ref<boolean>>;
}

export interface StageModule {
  setup(context: StageContext): StageInstance;
  /** Replaces the mission bar's deadline (the frame keeps the Prologue's and Stage 2's). */
  readonly missionDeadline?: (
    state: TeamGameViewState,
    focus: StageFocus,
  ) => MissionDeadline | null;
}

/** Every stage, registered or not (`null`: 準備中). */
export type StageRegistry = Readonly<Record<GameStageId, StageModule | null>>;
