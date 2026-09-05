import { describe, expect, it } from "vitest";

import { ensureSchema } from "../src/progress.js";
import type { SchemaRunner } from "../src/progress.js";

/**
 * ensureSchemaの初期化状態はモジュールスコープに1つしかなく、テストファイル内で
 * 持ち越される。実D1を叩くprogress.test.tsと同居させると「まだ初期化していない」
 * 状態から始められないので、Fakeを注入するこの検証だけを別ファイルへ分ける。
 *
 * HTTP経由（progress.test.tsのコールドスタート試験）ではD1側がクエリを直列化するため、
 * 初期化の競合を再現できない。DDLの完了を任意のタイミングまで遅らせられるFakeで、
 * 「後続の呼び出しが初期化の完了を待つこと」を直接確かめる。
 */
/**
 * 1回の初期化で流すDDLの本数。CREATE群（progressSchemaSql）と、既存DBへ列を足す
 * ALTER。ALTERは2度目以降「列が既にある」で失敗するのが正常なので、実装側で
 * 握りつぶしている（progress.tsのPROGRESS_ALTERS）。
 */
const MIGRATION_STATEMENTS = 2;

const deferredRunner = (): { runner: SchemaRunner; calls: () => number; finish: () => void } => {
  let calls = 0;
  let released = false;
  const pending: (() => void)[] = [];
  const runner: SchemaRunner = {
    exec: () => {
      calls += 1;
      // 解放後に来た文（1本目の完了を待って流れるALTER）はそのまま通す。
      if (released) return Promise.resolve({ count: 2, duration: 0 });
      return new Promise((resolve) => {
        pending.push(() => {
          resolve({ count: 2, duration: 0 });
        });
      });
    },
  };
  return {
    runner,
    calls: () => calls,
    finish: () => {
      if (pending.length === 0) throw new Error("execがまだ呼ばれていません。");
      released = true;
      for (const resolve of pending.splice(0)) resolve();
    },
  };
};

/** マイクロタスクを流し切って、「今この瞬間に完了しているもの」だけを観測する。 */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("ensureSchema", () => {
  // 失敗時は初期化状態がnullへ戻るので、後続のテストは未初期化から始められる。
  // この順序に依存しているため、テストを入れ替えるときは注意すること。
  it("初期化に失敗したら、次の呼び出しで作り直しを試みる", async () => {
    let calls = 0;
    const runner: SchemaRunner = {
      exec: () => {
        calls += 1;
        return Promise.reject(new Error("D1 down"));
      },
    };

    await expect(ensureSchema(runner)).rejects.toThrow("D1 down");
    await expect(ensureSchema(runner)).rejects.toThrow("D1 down");
    expect(calls).toBe(2);
  });

  it("初期化中に来た呼び出しを待たせ、DDLは1回だけ流す", async () => {
    const { runner, calls, finish } = deferredRunner();

    let settled = 0;
    const count = (): void => {
      settled += 1;
    };
    const first = ensureSchema(runner).then(count);
    const second = ensureSchema(runner).then(count);

    await flush();
    // 真偽値フラグ方式だと、2本目はテーブル作成の完了を待たずにここで完了してしまう。
    expect(calls()).toBe(1);
    expect(settled).toBe(0);

    finish();
    await Promise.all([first, second]);
    expect(settled).toBe(2);
    // 2本目の呼び出しぶんは流れない。増えるのは1回の初期化に含まれるDDLの本数だけ。
    expect(calls()).toBe(MIGRATION_STATEMENTS);
  });

  // 直前のテストで初期化が完了している前提。以後は新しいDBを渡してもexecを呼ばず、
  // 完了済みの結果をそのまま返す（毎リクエストでDDLを流さないための記憶が効いている）。
  it("初期化に成功した後はDDLを流し直さない", async () => {
    const { runner, calls } = deferredRunner();

    await expect(ensureSchema(runner)).resolves.toBeUndefined();
    expect(calls()).toBe(0);
  });
});
