import type { IdGenerator } from "../ports/id-generator.js";

export class FakeIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly identifiers: readonly string[]) {}

  next(): string {
    const identifier = this.identifiers.at(this.index);
    this.index += 1;
    if (identifier === undefined) {
      throw new Error("FakeIdGeneratorのIDが不足しています。");
    }
    return identifier;
  }
}
