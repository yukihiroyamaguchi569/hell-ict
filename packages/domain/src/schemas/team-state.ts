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

/**
 * リセット世代。ゲームマスターがチームを初期化するたびにDurable Object側で+1され、
 * 入室（POST /api/session）の応答でクライアントへ渡る。以後クライアントは進捗記録と
 * チェックポイント保存にこの値を添え、サーバは一致しない書き込みを拒否する。
 *
 * 未指定は0として扱う。リセットを持たない古いクライアントとの後方互換であり、
 * 一度もリセットしていないチーム（世代0）では今までどおり素通りする。
 */
export const resetGenerationSchema = z.number().int().nonnegative().default(0);

export const teamSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    state: teamStateSchema,
  })
  .strict();

/**
 * 入室（POST /api/session）の応答。teamSnapshotにリセット世代を1つ足しただけの形。
 *
 * teamSnapshotSchema自体は増やさない——WebSocket配信（teamSyncMessageSchema）でも
 * 同じstrictな形を使っており、世代はチームの状態ではなく「この端末がいつ入室したか」の
 * 印なので、配信のたびに載せる値ではない。
 */
export const sessionResultSchema = teamSnapshotSchema
  .extend({ generation: resetGenerationSchema })
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
export type SessionResult = z.infer<typeof sessionResultSchema>;
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type LeaderboardSnapshot = z.infer<typeof leaderboardSnapshotSchema>;
