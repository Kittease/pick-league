/**
 * Buffered work source: refills from the database in batches and never hands out an item that
 * is already being processed (claims don't hold row locks across our HTTP calls).
 */
export class WorkSource<T> {
  private buffer: T[] = [];
  private readonly inFlight = new Set<string>();
  private refilling: Promise<void> | null = null;

  constructor(
    private readonly fetchBatch: (exclude: ReadonlySet<string>) => Promise<T[]>,
    private readonly key: (item: T) => string,
  ) {}

  /** Next item, or null when there is nothing to do right now. */
  async next(): Promise<T | null> {
    if (this.buffer.length === 0) {
      if (!this.refilling) {
        this.refilling = this.refill().finally(() => {
          this.refilling = null;
        });
      }
      await this.refilling;
    }
    const item = this.buffer.shift();
    if (item === undefined) return null;
    this.inFlight.add(this.key(item));
    return item;
  }

  /** Call when an item handed out by `next` is finished (success or not). */
  release(item: T): void {
    this.inFlight.delete(this.key(item));
  }

  get size(): number {
    return this.buffer.length;
  }

  get active(): number {
    return this.inFlight.size;
  }

  private async refill(): Promise<void> {
    const batch = await this.fetchBatch(this.inFlight);
    this.buffer = batch.filter((item) => !this.inFlight.has(this.key(item)));
  }
}
