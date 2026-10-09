export const RECEIVE_LIMITS = {
  count: 2048,
  bytes: 64 * 1024 * 1024,
  batchCount: 128,
  windowMs: 20,
} as const;

export interface ReceiveQueueStats {
  pendingCount: number;
  pendingBytes: number;
  peakCount: number;
  peakBytes: number;
  accepted: number;
  dropped: number;
  failures: number;
}

// Count and byte reservations stay charged until the entire processing/history/
// display flush completes. There is only one consumer, including across awaits.
export class ReceiveQueue<T> {
  readonly stats: ReceiveQueueStats = {
    pendingCount: 0, pendingBytes: 0, peakCount: 0, peakBytes: 0,
    accepted: 0, dropped: 0, failures: 0,
  };
  private entries: { item: T; bytes: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly consume: (items: T[], reserve: (bytes: number) => boolean) => Promise<void>,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly limits: { count: number; bytes: number; batchCount: number; windowMs: number } = RECEIVE_LIMITS,
  ) {}

  offer(bytes: number, create: () => T): boolean {
    if (this.stats.pendingCount >= this.limits.count || this.stats.pendingBytes + bytes > this.limits.bytes) {
      this.stats.dropped++;
      return false;
    }
    this.entries.push({ item: create(), bytes });
    this.stats.pendingCount++;
    this.stats.pendingBytes += bytes;
    this.stats.accepted++;
    this.updatePeaks();
    if (!this.running) {
      if (this.entries.length >= this.limits.batchCount) void this.flush();
      else if (this.timer === undefined) this.timer = setTimeout(() => void this.flush(), this.limits.windowMs);
    }
    return true;
  }

  drop() { this.stats.dropped++; }
  failure(error: unknown) {
    this.stats.failures++;
    // Observability must not break the drain's recovery guarantees.
    try { this.failed(error); } catch { /* Observer failure; counter remains visible. */ }
  }

  private updatePeaks() {
    this.stats.peakCount = Math.max(this.stats.peakCount, this.stats.pendingCount);
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.stats.pendingBytes);
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    // Start on a microtask, ensuring running is set before the consumer can reenter.
    this.running = Promise.resolve().then(async () => {
      while (this.entries.length) {
        const batch = this.entries.splice(0, this.limits.batchCount);
        let charged = batch.reduce((sum, entry) => sum + entry.bytes, 0);
        try {
          await this.consume(batch.map(entry => entry.item), bytes => {
            if (this.stats.pendingBytes + bytes > this.limits.bytes) return false;
            charged += bytes;
            this.stats.pendingBytes += bytes;
            this.updatePeaks();
            return true;
          });
        } catch (error) {
          this.failure(error);
        } finally {
          this.stats.pendingCount -= batch.length;
          this.stats.pendingBytes -= charged;
          try { this.changed(); } catch (error) { this.failure(error); }
        }
      }
    }).finally(() => {
      this.running = undefined;
      // A change observer may have enqueued while the worker was finishing.
      if (this.entries.length) void this.flush();
    });
    return this.running;
  }
}
