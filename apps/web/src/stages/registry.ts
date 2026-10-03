import { prologueStage } from "./prologue/index.js";
import { stage1 } from "./s1/index.js";
import { stage2 } from "./s2/index.js";
import { stage3 } from "./s3/index.js";
import { stage4 } from "./s4/index.js";
import { stage5 } from "./s5/index.js";
import { stage6 } from "./s6/index.js";
import { finalStage } from "./final/index.js";
import type { StageRegistry } from "./stage-module.js";

/**
 * Every stage's module. Each stage's PR changes only its own `./<id>/index.ts`, never this file.
 */
export const stageRegistry: StageRegistry = {
  prologue: prologueStage,
  s1: stage1,
  s2: stage2,
  s3: stage3,
  s4: stage4,
  s5: stage5,
  s6: stage6,
  final: finalStage,
};
