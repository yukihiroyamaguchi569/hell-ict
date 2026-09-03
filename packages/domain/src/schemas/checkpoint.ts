import { z } from "zod";

import { commandIdSchema, revisionSchema, teamCodeSchema } from "./team-state.js";

/**
 * `data`のJSON化サイズ上限。ステージ固有の状態はサーバーから見て不透明なので、
 * 中身ではなく大きさだけを制約する——1チーム1 Durable ObjectのSQLiteへ毎オート
 * セーブで書き込むため、際限なく太らせない。
 */
export const CHECKPOINT_DATA_MAX_BYTES = 64 * 1024;

/** 上限超過をWorkerが400（他のschema違反と区別した文言）へ写すための識別子。 */
export const CHECKPOINT_DATA_TOO_LARGE_MESSAGE = "チェックポイントのdataが大きすぎます。";

const jsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * 保存を拒否した理由。HTTPエラーの`code`としてそのまま返すため、schemaを情報源にする
 * （`schemas/http-error.ts`が同じ値を取り込む）——クライアントは文言ではなくこの値で
 * 分岐する。conflictは取り直して再送、*-regressionは巻き戻した状態を送り直さない。
 */
export const CHECKPOINT_REJECTION_REASONS = [
  "conflict",
  "trap-regression",
  "elapsed-regression",
  "pos-regression",
] as const;

export const checkpointRejectionReasonSchema = z.enum(CHECKPOINT_REJECTION_REASONS);

/** 罠の発動済みフラグ。Stage 3・Stage 4のどちらも1回だけ発動する（企画書§6）。 */
export const checkpointTrapSchema = z.object({ s3Used: z.boolean(), s4Used: z.boolean() }).strict();

export const checkpointBodySchema = z
  .object({
    view: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9-]+$/),
    pos: z.number().int().min(0).max(7),
    elapsedMs: z.number().int().nonnegative(),
    trap: checkpointTrapSchema,
    // ステージ固有の状態は不透明なまま預かる。サーバーは形を解釈せず、
    // 大きさだけを見る——ステージ実装のたびにschemaを追う運用にしないため。
    data: z
      .record(z.string(), z.unknown())
      .refine((value) => jsonByteLength(value) <= CHECKPOINT_DATA_MAX_BYTES, {
        error: CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
      }),
  })
  .strict();

export const checkpointSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    savedAt: z.iso.datetime(),
    body: checkpointBodySchema,
  })
  .strict();

export const saveCheckpointCommandSchema = z
  .object({
    type: z.literal("save-checkpoint"),
    commandId: commandIdSchema,
    expectedRevision: revisionSchema,
    body: checkpointBodySchema,
  })
  .strict();

export const saveCheckpointResultSchema = z.object({ snapshot: checkpointSnapshotSchema }).strict();

/** GET応答。`serverNow`はクライアントが経過時間の基準をサーバーへ合わせるために返す。 */
export const checkpointStateSchema = z
  .object({
    checkpoint: checkpointSnapshotSchema.nullable(),
    serverNow: z.iso.datetime(),
  })
  .strict();

export type CheckpointRejectionReason = z.infer<typeof checkpointRejectionReasonSchema>;
export type CheckpointTrap = z.infer<typeof checkpointTrapSchema>;
export type CheckpointBody = z.infer<typeof checkpointBodySchema>;
export type CheckpointSnapshot = z.infer<typeof checkpointSnapshotSchema>;
export type SaveCheckpointCommand = z.infer<typeof saveCheckpointCommandSchema>;
export type SaveCheckpointResult = z.infer<typeof saveCheckpointResultSchema>;
export type CheckpointState = z.infer<typeof checkpointStateSchema>;
