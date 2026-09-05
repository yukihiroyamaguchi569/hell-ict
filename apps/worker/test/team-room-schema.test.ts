import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyAddColumns, isDuplicateColumn } from "../src/sqlite.js";
import type { AddColumnRunner } from "../src/sqlite.js";
import { TEAM_ROOM_ADD_COLUMNS, TeamRoom } from "../src/team-room.js";

/**
 * 流した文を記録し、`fail`が返したエラーで落とすFake。列追加の移行が「どの失敗を握り、
 * どこで止まるか」を、実ストレージ抜きで直接確かめるために使う。
 */
const recordingRunner = (
  fail: (query: string) => Error | null,
): { runner: AddColumnRunner; executed: string[] } => {
  const executed: string[] = [];
  const runner: AddColumnRunner = {
    exec: (query: string) => {
      executed.push(query);
      const failure = fail(query);
      if (failure !== null) throw failure;
      return undefined;
    },
  };
  return { runner, executed };
};

const STATEMENTS = ["ALTER TABLE a ADD COLUMN x TEXT", "ALTER TABLE b ADD COLUMN y TEXT"] as const;

describe("applyAddColumns", () => {
  it("『列が既にある』は握り、後続の文も流す", () => {
    // 2度目以降の起動。全部の文がこの失敗を返すのが正常な姿。
    const { runner, executed } = recordingRunner(
      () => new Error("duplicate column name: x: SQLITE_ERROR"),
    );

    expect(() => {
      applyAddColumns(runner, STATEMENTS);
    }).not.toThrow();
    expect(executed).toEqual([...STATEMENTS]);
  });

  it("テーブルが無い失敗は投げ、その先の文を流さない", () => {
    // 握ると、列の無いままコンストラクタが成功扱いになる（Issue #101の元の姿）。
    const { runner, executed } = recordingRunner((query) =>
      query === STATEMENTS[0] ? new Error("no such table: a") : null,
    );

    expect(() => {
      applyAddColumns(runner, STATEMENTS);
    }).toThrow("no such table");
    expect(executed).toEqual([STATEMENTS[0]]);
  });

  it("ストレージが落ちた失敗も投げ、その先の文を流さない", () => {
    const { runner, executed } = recordingRunner((query) =>
      query === STATEMENTS[0] ? new Error("Network connection lost.") : null,
    );

    expect(() => {
      applyAddColumns(runner, STATEMENTS);
    }).toThrow("Network connection lost.");
    expect(executed).toEqual([STATEMENTS[0]]);
  });

  it("空の一覧では何も流さない", () => {
    const { runner, executed } = recordingRunner(() => null);

    applyAddColumns(runner, []);
    expect(executed).toEqual([]);
  });
});

describe("TeamRoomのスキーマ移行", () => {
  /**
   * 既にテーブルと列が揃ったストレージからの作り直し。コンストラクタは毎回同じDDLを
   * 流すので、ここが通ることが「2度目以降の起動が落ちない」ことの確認になる。
   */
  it("移行済みのストレージでもコンストラクタが通る", async () => {
    await runInDurableObject(env.TEAM_ROOM.getByName("500091"), (_instance, state) => {
      expect(() => new TeamRoom(state, env)).not.toThrow();
    });
  });

  /**
   * 文言での判定なので、実際のDOストレージが返す失敗と突き合わせる。全文が
   * 「列が既にある」で失敗する＝コンストラクタ通過後に全列が揃っている、という証拠。
   *
   * ALTERをCREATEより先に流していた頃、processed_checkpoint_commandsの1本は
   * `no such table`で失敗していた（すべての例外を握っていたので表に出なかった）。
   * 握る範囲を「列が既にある」だけへ絞った以上、順序が戻れば初期化ごと落ちる。
   */
  it("コンストラクタ通過後は、各ADD COLUMNが『列が既にある』で失敗する", async () => {
    const messages = await runInDurableObject(
      env.TEAM_ROOM.getByName("500092"),
      (_instance, state) =>
        TEAM_ROOM_ADD_COLUMNS.map((statement) => {
          try {
            state.storage.sql.exec(statement);
            return null;
          } catch (caught) {
            return caught instanceof Error ? caught.message : String(caught);
          }
        }),
    );

    expect(messages).toHaveLength(TEAM_ROOM_ADD_COLUMNS.length);
    for (const message of messages) {
      expect(message).not.toBeNull();
      expect(isDuplicateColumn(new Error(message ?? ""))).toBe(true);
    }
  });
});
