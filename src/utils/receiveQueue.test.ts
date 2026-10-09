import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiveQueue } from "./receiveQueue";

describe("bounded receive worker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancels the threshold timer, rearms once, and has no idle wakes", async () => {
    const consume = vi.fn(async (_items: number[]) => {});
    const queue = new ReceiveQueue<number>(consume, () => {}, () => {}, { count: 4, bytes: 100, batchCount: 2, windowMs: 20 });
    queue.offer(1, () => 1);
    expect(vi.getTimerCount()).toBe(1);
    queue.offer(1, () => 2);
    await queue.flush();
    expect(consume.mock.calls[0][0]).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
    queue.offer(1, () => 3);
    await vi.advanceTimersByTimeAsync(20);
    expect(consume).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts in-flight entries against both caps and resumes after a slow consumer", async () => {
    let release!: () => void;
    const seen: number[] = [];
    const queue = new ReceiveQueue<number>(async items => {
      seen.push(...items);
      if (items[0] === 1) await new Promise<void>(resolve => { release = resolve; });
    }, () => {}, () => {}, { count: 3, bytes: 10, batchCount: 1, windowMs: 20 });
    queue.offer(4, () => 1);
    await Promise.resolve();
    expect(queue.offer(4, () => 2)).toBe(true);
    expect(queue.offer(4, () => 3)).toBe(false);
    expect(queue.offer(2, () => 3)).toBe(true);
    expect(queue.offer(0, () => 4)).toBe(false);
    expect(queue.stats).toMatchObject({ pendingCount: 3, pendingBytes: 10, peakCount: 3, peakBytes: 10, dropped: 2 });
    release();
    await queue.flush();
    expect(seen).toEqual([1, 2, 3]);
    expect(queue.stats.pendingCount).toBe(0);
    expect(queue.stats.pendingBytes).toBe(0);
  });

  it("rejects processed expansion and recovers after a thrown flush", async () => {
    const failed = vi.fn();
    const seen: number[] = [];
    const queue = new ReceiveQueue<number>(async (items, reserve) => {
      if (items[0] === 1) {
        expect(reserve(100)).toBe(false);
        throw new Error("flush failed");
      }
      seen.push(...items);
    }, () => {}, failed, { count: 4, bytes: 10, batchCount: 1, windowMs: 20 });
    queue.offer(2, () => 1);
    queue.offer(2, () => 2);
    await queue.flush();
    queue.offer(2, () => 3);
    await queue.flush();
    expect(seen).toEqual([2, 3]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(queue.stats).toMatchObject({ pendingCount: 0, pendingBytes: 0, failures: 1 });
  });
});
