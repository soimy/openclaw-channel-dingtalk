export const FEEDBACK_RETRY_INDEX_LIMIT = 1024;

/** Small, disposable scheduling hints. Receipts remain the durable source of truth. */
export class FeedbackRetryIndex<T extends { due: number }> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit = FEEDBACK_RETRY_INDEX_LIMIT) {}

  get size(): number {
    return this.entries.size;
  }
  get(key: string): T | undefined {
    return this.entries.get(key);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  /** Return the omitted hint so its deadline can still trigger durable recovery. */
  set(key: string, value: T): T | undefined {
    if (this.entries.has(key) || this.entries.size < this.limit) {
      this.entries.set(key, value);
      return;
    }
    let latest: [string, T] | undefined;
    for (const entry of this.entries) {
      if (!latest || entry[1].due > latest[1].due) {
        latest = entry;
      }
    }
    if (!latest || value.due >= latest[1].due) {
      return value;
    }
    // Keep the nearest deadlines. Eviction never deletes a receipt or outbox.
    this.entries.delete(latest[0]);
    this.entries.set(key, value);
    return latest[1];
  }
  private earliest(): [string, T] | undefined {
    let first: [string, T] | undefined;
    for (const entry of this.entries) {
      if (!first || entry[1].due < first[1].due) {
        first = entry;
      }
    }
    return first;
  }
  nextDue(): number | undefined {
    return this.earliest()?.[1].due;
  }
  takeDue(now: number): T | undefined {
    const first = this.earliest();
    if (!first || first[1].due > now) {
      return;
    }
    this.entries.delete(first[0]);
    return first[1];
  }
}
