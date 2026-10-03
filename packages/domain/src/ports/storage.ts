export interface Storage<T> {
  load(key: string): Promise<T | undefined>;
  save(key: string, value: T): Promise<void>;
}
