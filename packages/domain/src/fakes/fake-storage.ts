import type { Storage } from "../ports/storage.js";

export class FakeStorage<T> implements Storage<T> {
  private readonly values = new Map<string, T>();
  private pendingFailure: Error | undefined;

  failNextSave(error: Error): void {
    this.pendingFailure = error;
  }

  load(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  save(key: string, value: T): Promise<void> {
    if (this.pendingFailure !== undefined) {
      const error = this.pendingFailure;
      this.pendingFailure = undefined;
      return Promise.reject(error);
    }
    this.values.set(key, value);
    return Promise.resolve();
  }
}
