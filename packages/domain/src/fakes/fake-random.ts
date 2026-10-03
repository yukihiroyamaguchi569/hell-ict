import type { Random } from "../ports/random.js";

export class FakeRandom implements Random {
  private index = 0;

  constructor(private readonly values: readonly number[]) {}

  next(): number {
    const value = this.values.at(this.index);
    this.index += 1;
    if (value === undefined) {
      throw new Error("FakeRandomの値が不足しています。");
    }
    return value;
  }
}
