import { describe, expect, it } from "vitest";

import {
  allFilled,
  finishFilling,
  shelfCount,
  shelfWards,
  startFilling,
  startShelf,
  type BottleShelf,
} from "../../../src/stages/s3/bottles.js";

/** Fills bottle `index` from start to end; fails the test if it could not start. */
const fill = (shelf: BottleShelf, index: number) => {
  const filling = startFilling(shelf, index);
  if (filling === null) throw new Error(`bottle ${String(index)} could not start`);
  return finishFilling(filling, index);
};

const fillRange = (shelf: BottleShelf, from: number, to: number): BottleShelf => {
  let current = shelf;
  for (let i = from; i < to; i++) current = fill(current, i).shelf;
  return current;
};

describe("bottles", () => {
  it("最初は 5A の20本、すべて未補充", () => {
    const shelf = startShelf();
    expect(shelfCount(shelf)).toBe("済 0 / 全 20 本");
    expect(shelfWards(shelf).map((w) => [w.ward, w.items.length])).toEqual([["5A", 20]]);
    expect(allFilled(shelf)).toBe(false);
  });

  it("詰め中・済みのボトルは押しても始まらない。範囲外も同じ", () => {
    const filling = startFilling(startShelf(), 0);
    expect(filling?.bottles[0]?.state).toBe("filling");
    if (filling === null) throw new Error();
    expect(startFilling(filling, 0)).toBeNull();
    expect(startFilling(fill(startShelf(), 0).shelf, 0)).toBeNull();
    expect(startFilling(startShelf(), 20)).toBeNull();
    expect(startFilling(startShelf(), -1)).toBeNull();
  });

  it("詰め中でないボトルの完了は何も変えない", () => {
    const shelf = startShelf();
    expect(finishFilling(shelf, 0)).toEqual({ shelf, landed: null });
  });

  it("5A を14本詰めても湧かず、15本目で 5B の10本が末尾に湧く（1回だけ）", () => {
    const fourteen = fillRange(startShelf(), 0, 14);
    expect(fourteen.bottles).toHaveLength(20);
    const fifteenth = fill(fourteen, 14);
    expect(fifteenth.landed).toBe("5B");
    expect(shelfCount(fifteenth.shelf)).toBe("済 15 / 全 30 本");
    expect(fill(fifteenth.shelf, 15).landed).toBeNull();
  });

  it("5B は 5B 自身の済みが8本で 5C が湧く（全体の本数では数えない）", () => {
    const withB = fillRange(startShelf(), 0, 20);
    expect(withB.bottles).toHaveLength(30);
    const sevenB = fillRange(withB, 20, 27);
    expect(sevenB.bottles).toHaveLength(30);
    const eighth = fill(sevenB, 27);
    expect(eighth.landed).toBe("5C");
    expect(shelfWards(eighth.shelf).map((w) => w.ward)).toEqual(["5A", "5B", "5C"]);
  });

  it("40本すべて詰めたら終わり。それ以上は湧かない", () => {
    const all = fillRange(startShelf(), 0, 40);
    expect(shelfCount(all)).toBe("済 40 / 全 40 本");
    expect(all.waves).toEqual([]);
    expect(allFilled(all)).toBe(true);
  });
});
