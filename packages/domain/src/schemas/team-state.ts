import { z } from "zod";

export const teamCodeSchema = z.string().regex(/^\d{6}$/);
export const commandIdSchema = z.uuid();
export const revisionSchema = z.number().int().nonnegative();

export const teamStateSchema = z
  .object({
    mode: z.literal("peace"),
    stage: z.enum(["prologue", "stage1"]),
    metrics: z
      .object({
        occupancy: z.literal(398),
        capacity: z.literal(400),
        availableBeds: z.literal(2),
        unknownFever: z.literal(3),
      })
      .strict(),
  })
  .strict();

export const teamSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    state: teamStateSchema,
  })
  .strict();

export const teamCommandSchema = z
  .object({
    type: z.literal("enter-stage1"),
    commandId: commandIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

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
    stage: z.enum(["prologue", "stage1"]),
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
export type TeamState = z.infer<typeof teamStateSchema>;
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type LeaderboardSnapshot = z.infer<typeof leaderboardSnapshotSchema>;
