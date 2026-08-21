import { z } from "zod";

export const teamCodeSchema = z.string().regex(/^\d{6}$/);
export const commandIdSchema = z.uuid();
export const revisionSchema = z.number().int().nonnegative();

export const stageSchema = z.enum(["prologue", "stage1"]);

const metricsSchema = z
  .object({
    occupancy: z.literal(398),
    capacity: z.literal(400),
    availableBeds: z.literal(2),
    unknownFever: z.literal(3),
  })
  .strict();

export const stage1EmailIdSchema = z.enum([
  "m1",
  "m2",
  "m3",
  "m4",
  "m5",
  "m6",
  "m7",
  "m8",
  "m9",
  "m10",
]);

export const stage1ReplySchema = z
  .object({
    emailId: stage1EmailIdSchema,
    polite: z.boolean(),
  })
  .strict();

export const stage1StateSchema = z
  .object({
    roundStartedAt: z.iso.datetime(),
    replies: z.array(stage1ReplySchema),
  })
  .strict();

export const teamStateSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("prologue"),
      mode: z.literal("peace"),
      metrics: metricsSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal("stage1"),
      mode: z.literal("peace"),
      metrics: metricsSchema,
      stage1: stage1StateSchema,
    })
    .strict(),
]);

export const teamSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    state: teamStateSchema,
  })
  .strict();

export const enterStage1CommandSchema = z
  .object({
    type: z.literal("enter-stage1"),
    commandId: commandIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const submitStage1ReplyCommandSchema = z
  .object({
    type: z.literal("submit-stage1-reply"),
    commandId: commandIdSchema,
    expectedRevision: revisionSchema,
    emailId: stage1EmailIdSchema,
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

export const teamCommandSchema = z.discriminatedUnion("type", [
  enterStage1CommandSchema,
  submitStage1ReplyCommandSchema,
]);

export const commandResultSchema = z
  .object({
    snapshot: teamSnapshotSchema,
    applied: z.boolean(),
    leaderboardPending: z.boolean(),
  })
  .strict();

export const leaderboardEntrySchema = z
  .object({
    marker: z.string().min(1),
    isSelf: z.boolean(),
    stage: stageSchema,
    teamRevision: revisionSchema,
  })
  .strict();

export const leaderboardSnapshotSchema = z
  .object({
    revision: revisionSchema,
    entries: z.array(leaderboardEntrySchema),
  })
  .strict();

export const teamSocketAttachmentSchema = z
  .object({ kind: z.literal("team"), teamCode: teamCodeSchema })
  .strict();
export const leaderboardSocketAttachmentSchema = z
  .object({
    kind: z.literal("leaderboard"),
    teamCode: teamCodeSchema,
  })
  .strict();

export type TeamCode = z.infer<typeof teamCodeSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Stage1EmailId = z.infer<typeof stage1EmailIdSchema>;
export type Stage1Reply = z.infer<typeof stage1ReplySchema>;
export type Stage1State = z.infer<typeof stage1StateSchema>;
export type TeamState = z.infer<typeof teamStateSchema>;
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;
export type EnterStage1Command = z.infer<typeof enterStage1CommandSchema>;
export type SubmitStage1ReplyCommand = z.infer<typeof submitStage1ReplyCommandSchema>;
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type LeaderboardSnapshot = z.infer<typeof leaderboardSnapshotSchema>;
