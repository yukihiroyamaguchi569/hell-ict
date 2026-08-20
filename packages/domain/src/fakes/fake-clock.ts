import type { Clock } from "../ports/clock.js";

export class FakeClock implements Clock {
  private current: Date;

  constructor(current: Date) {
    this.current = new Date(current);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceBy(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
