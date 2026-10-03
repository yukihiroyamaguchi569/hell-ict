import type { ViewerId } from "@hell-ict/content";
import type { GameStageId } from "@hell-ict/domain";
import { computed, effectScope, onScopeDispose, shallowRef, watch } from "vue";
import type { Component, ComputedRef, EffectScope, ShallowRef } from "vue";

import type { ChatSubmit, ScriptedChat } from "../chat/use-scripted-chat.js";
import type { StageFocus } from "../shell/mission-bar-view.js";
import type { RightPane } from "../shell/shell-view.js";
import type { StageContext, StageInstance, StageModule, StageRegistry } from "./stage-module.js";

export interface StageFrame {
  /** The module of the stage on screen, or `null` (no stage on screen, or 準備中). */
  readonly module: ComputedRef<StageModule | null>;
  /** What the module's `setup` built for this stay in the stage. */
  readonly instance: Readonly<ShallowRef<StageInstance | null>>;
  readonly focus: ComputedRef<StageFocus>;
  readonly overlayWanted: ComputedRef<boolean>;
  readonly rightOverride: ComputedRef<RightPane | null>;
  /** The stage's toolbar part for the document open in the viewer (`null`: none, or no doc). */
  viewerToolbar(doc: ViewerId | null): Component | null;
  /** The stage's own chat sending (`undefined`: the chat sends to the server's AI). */
  readonly chatSubmit: ComputedRef<ChatSubmit | undefined>;
  /** The stage's own conversation (`StageInstance.chat`; `undefined`: none). */
  readonly chat: ComputedRef<ScriptedChat | undefined>;
  /** The stage holds back the clear effect (`StageInstance.holdClear`, only with an overlay). */
  readonly clearHeld: ComputedRef<boolean>;
}

/**
 * Builds the stage on screen and drops it when the team leaves it. `stage` is `null` while no
 * stage should run (entry, a stale tab): nothing of a stage is left to write then. The module's
 * `setup` runs once per stay, in a scope of its own that is stopped on leaving, so a stage's
 * timers and watchers never outlive it.
 */
export const useStageFrame = (
  stage: () => GameStageId | null,
  registry: StageRegistry,
  context: StageContext,
): StageFrame => {
  const module = computed(() => {
    const id = stage();
    return id === null ? null : registry[id];
  });
  const instance = shallowRef<StageInstance | null>(null);
  let scope: EffectScope | null = null;

  const leave = (): void => {
    scope?.stop();
    scope = null;
    instance.value = null;
  };

  watch(
    module,
    (next) => {
      leave();
      if (next === null) return;
      // Detached: it is stopped here on leaving, not by whatever scope runs this watcher.
      const own = effectScope(true);
      scope = own;
      instance.value = own.run(() => next.setup(context)) ?? null;
    },
    { immediate: true },
  );
  onScopeDispose(leave);

  // A hold without a window to show would leave the team with neither the window nor the
  // effect: stuck. Only a stage that has an overlay may hold, and while it holds its window is up.
  const clearHeld = computed(
    () => instance.value?.overlay !== undefined && (instance.value.holdClear?.value ?? false),
  );

  return {
    module,
    instance,
    focus: computed(() => instance.value?.focus?.value ?? null),
    overlayWanted: computed(
      () => (instance.value?.overlayWanted?.value ?? false) || clearHeld.value,
    ),
    rightOverride: computed(() => instance.value?.rightPane?.value ?? null),
    viewerToolbar: (doc) => (doc === null ? null : (instance.value?.viewerToolbar?.(doc) ?? null)),
    chatSubmit: computed(() => instance.value?.chatSubmit),
    chat: computed(() => instance.value?.chat),
    clearHeld,
  };
};
