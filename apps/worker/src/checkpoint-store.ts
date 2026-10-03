import {
  applyCheckpoint,
  checkpointSnapshotSchema,
  normalizeLegacyCheckpointSnapshot,
} from "@hell-ict/domain";
import type {
  CheckpointRejectionReason,
  CheckpointSnapshot,
  SaveCheckpointCommand,
  TeamCode,
} from "@hell-ict/domain";
import { z } from "zod";

import { fingerprintSchema, mismatchesFingerprint } from "./guard.js";

/**
 * TeamRoom's checkpoint persistence: checkpoint_state (one snapshot row) and the
 * processed_checkpoint_commands idempotency ledger. Input parsing and the reset-generation
 * check stay in TeamRoom (the RPC surface); this store only reads and writes storage.
 */

type StoredCheckpointState = { snapshot: string };
/**
 * チェックポイント台帳の行。台帳のfingerprintを信用しない理由は、team-room.tsの
 * 冪等台帳の行（storedLedgerRowSchema）の注記と同じ。
 */
const storedCheckpointCommandSchema = z.object({
  revision: checkpointSnapshotSchema.shape.revision,
  fingerprint: fingerprintSchema.nullable(),
});

export type StoredCheckpointCommand = z.infer<typeof storedCheckpointCommandSchema>;

/** チェックポイント保存の拒否理由。Workerが理由ごとに409の文言を分ける。 */
export type CheckpointRejection = { rejected: CheckpointRejectionReason };

/**
 * transactionSyncを巻き戻すためだけの内部シグナル。CASが0行だったことを
 * 例外として伝え、CheckpointStore.saveでconflictへ写す。DOの外へは漏らさない。
 */
class CheckpointConflictError extends Error {}

/**
 * 台帳にあるcommandIdへの再送を、本文を見ずに処理する。適用済みのコマンドは二度と
 * 適用しない——台帳が指すrevisionが今のrevisionなら「直前の保存の再送」なので現在の
 * snapshotをそのまま返し、ずれていれば既に上書きされた古い保存なのでconflictにする
 * （クライアントはGETして最新を採用すればよい）。この判定により、台帳はsnapshotを
 * 持たず`(command_id, revision)`だけで足り、剪定して有限に保つ必要も無くなる——
 * 剪定すると、溢れた古いcommandIdの再送が「未処理」に見え、古いdataが最新revision
 * の新規保存として通ってしまう。
 */
export const replayCheckpoint = (
  current: CheckpointSnapshot | null,
  saved: StoredCheckpointCommand,
  fingerprint: string,
): CheckpointSnapshot | CheckpointRejection => {
  // 同じcommandIdで別のbodyを送る取り違えは冪等再送ではない。元の結果を返すと、
  // クライアントは保存したつもりの状態が入っていないことに気づけない。
  if (mismatchesFingerprint(saved.fingerprint, fingerprint)) return { rejected: "conflict" };
  return current !== null && current.revision === saved.revision
    ? current
    : { rejected: "conflict" };
};

/** Parsed inputs of a save besides the command itself. */
export type CheckpointSaveContext = {
  readonly teamCode: TeamCode;
  readonly now: CheckpointSnapshot["savedAt"];
  readonly fingerprint: string;
};

export class CheckpointStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  read(): CheckpointSnapshot | null {
    const stored =
      this.storage.sql
        .exec<StoredCheckpointState>("SELECT snapshot FROM checkpoint_state WHERE id = 1")
        .toArray()[0] ?? null;
    // 2026-09-06の内部名振り直し（Issue #118）より前に保存されたsnapshotは、旧名の
    // まま置いてある。strictなschemaはそれを弾くので、parseの前に新名へ読み替える
    // ——ここで落とすと、そのチームは復帰できないままリセットを待つことになる。
    return stored === null
      ? null
      : checkpointSnapshotSchema.parse(
          normalizeLegacyCheckpointSnapshot(JSON.parse(stored.snapshot) as unknown),
        );
  }

  /** Saves a command whose generation the caller has already checked. */
  save(
    command: SaveCheckpointCommand,
    context: CheckpointSaveContext,
  ): CheckpointSnapshot | CheckpointRejection {
    const { teamCode, now, fingerprint } = context;
    const savedRow =
      this.storage.sql
        .exec(
          "SELECT revision, fingerprint FROM processed_checkpoint_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    const saved = savedRow === null ? null : storedCheckpointCommandSchema.parse(savedRow);
    const current = this.read();
    // 台帳の行も検証してから使う。壊れた行を「台帳に無い」と読み替えると、適用済みの
    // commandIdが未処理に見えて古いbodyを再適用してしまう。不整合は黙って通さず、
    // 例外にしてWorkerの503（時間を置いて再試行）へ倒す。
    if (saved !== null) return replayCheckpoint(current, saved, fingerprint);

    const applied = applyCheckpoint(current, command, { teamCode, now });
    if (!applied.ok) return { rejected: applied.reason };
    try {
      this.write(applied.snapshot, command, { current, fingerprint });
    } catch (caught) {
      if (caught instanceof CheckpointConflictError) return { rejected: "conflict" };
      throw caught;
    }
    return applied.snapshot;
  }

  /**
   * 状態更新と冪等台帳を1トランザクションで書く。片方だけ書けると、revisionだけ進んで
   * 台帳に記録が無い状態になり、同じcommandIdの再送が現在のsnapshotではなく新規の保存
   * として再適用されてしまう（AGENTS.mdの「保存失敗・重複イベント」）。CASが0行だった
   * 場合はreturnではロールバックできないので、例外で抜けてトランザクションごと巻き戻す。
   * saveの複雑度を下げるための切り出し。
   */
  private write(
    snapshot: CheckpointSnapshot,
    command: SaveCheckpointCommand,
    context: { current: CheckpointSnapshot | null; fingerprint: string },
  ): void {
    const { current, fingerprint } = context;
    // flushはCASを掛けずに確定させるので、照合はクライアントが申告したexpectedRevision
    // ではなく、直前に読んだ現在のrevision（合成の土台）で行う。通常の保存は従来どおり。
    const casRevision = command.flush === true ? current?.revision : command.expectedRevision;
    const serialized = JSON.stringify(snapshot);
    this.storage.transactionSync(() => {
      // 既存commandと同じくrevisionのCASで書く。想定外の並行更新があれば0行になる。
      const written =
        current === null
          ? this.storage.sql.exec(
              "INSERT OR IGNORE INTO checkpoint_state (id, snapshot) VALUES (1, ?)",
              serialized,
            ).rowsWritten
          : this.storage.sql.exec(
              "UPDATE checkpoint_state SET snapshot = ? WHERE id = 1 AND json_extract(snapshot, '$.revision') = ?",
              serialized,
              casRevision ?? 0,
            ).rowsWritten;
      if (written === 0) throw new CheckpointConflictError();
      this.storage.sql.exec(
        "INSERT INTO processed_checkpoint_commands (command_id, revision, created_at, fingerprint) VALUES (?, ?, ?, ?)",
        command.commandId,
        snapshot.revision,
        snapshot.savedAt,
        fingerprint,
      );
    });
  }
}
