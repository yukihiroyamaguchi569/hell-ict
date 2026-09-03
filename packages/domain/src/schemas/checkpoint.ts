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

/** JSONとして往復できる値。zodの再帰schemaは型注釈を要求するため、ここだけは手で書く。 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    // zod 4のz.number()は非有限値を受け付けないので、Infinity・NaNはここで落ちる。
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

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
    // ただし値はJSONとして往復できるものに限る。素通しにするとInfinity・NaN・
    // undefined・関数がすり抜け、保存時のJSON.stringifyで黙ってnullや欠落に化けて、
    // 復元した状態が保存した状態と食い違う。
    // 検証は再帰schemaで行い、静的な型はRecord<string, unknown>のまま浅く保つ——
    // 再帰型をそのまま推論させると、DOのRPC型（Rpc.Serializable）を通す時点で
    // TS2589（型の展開が深すぎる）になるため。値の解釈はステージ実装側の責務。
    data: z
      .record(z.string(), z.unknown())
      .refine((value) => jsonRecordSchema.safeParse(value).success)
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
