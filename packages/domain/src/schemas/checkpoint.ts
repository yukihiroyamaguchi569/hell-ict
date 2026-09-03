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

/**
 * `data`の入れ子の深さ上限。ステージ固有の状態は平坦〜数段のオブジェクトで足りる。
 * 深い値を再帰schemaへそのまま渡すとRangeErrorになり、検証が例外で落ちて400へすら
 * 写せないため、再帰parseの前に反復で深さを数えて弾く。
 */
export const CHECKPOINT_DATA_MAX_DEPTH = 8;

const jsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** 入れ子をたどる対象（配列・オブジェクト）の中身。それ以外は葉として扱う。 */
const childrenOf = (node: unknown): unknown[] => {
  if (Array.isArray(node)) return node;
  if (typeof node === "object" && node !== null) return Object.values(node);
  return [];
};

/**
 * `root`直下を深さ1として、`limit`段を超える値があるかを再帰せず1段ずつ広げて判定する。
 * 走査はlimit+1段で打ち切るので、深さ数千の入力でもスタックを消費しない。
 */
const exceedsDepth = (root: Record<string, unknown>, limit: number): boolean => {
  let level = childrenOf(root);
  for (let depth = 1; depth < limit && level.length > 0; depth += 1) {
    level = level.flatMap(childrenOf);
  }
  return level.flatMap(childrenOf).length > 0;
};

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
      // 深さ検査を先に、abortで打ち切ってから再帰parseへ進む。順序を入れ替えると、
      // 深すぎる値が再帰schemaへ届いてRangeErrorになる。
      .refine((value) => !exceedsDepth(value, CHECKPOINT_DATA_MAX_DEPTH), { abort: true })
      .refine((value) => jsonRecordSchema.safeParse(value).success, { abort: true })
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
