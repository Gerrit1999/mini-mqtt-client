import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorLogBuffer, errorFingerprint, stableSerialize, type ErrorLogInput } from './errorLogBuffer'

const options = { threshold: 50, flushMs: 1000, windowMs: 5000, maxGroups: 1000, retryMs: 5000 }
const input = (overrides: Partial<ErrorLogInput> = {}): ErrorLogInput => ({
  type: 'mqtt', message: 'failed', timestamp: new Date(), ...overrides,
})
const metadata = (entry: { details: string | null }) => JSON.parse(entry.details!).aggregation
const deferred = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('error disk buffering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('fingerprints ignore key order and timestamps but preserve type, reason and every context field', () => {
    const base = input({ details: { reason: 'timeout', nested: { b: 2, a: 1 } },
      context: { serverId: 1, topic: 'a', command: 'publish' } })
    expect(errorFingerprint(base)).toBe(errorFingerprint({
      ...base, timestamp: new Date(0),
      details: { nested: { a: 1, b: 2 }, reason: 'timeout' },
      context: { command: 'publish', topic: 'a', serverId: 1 },
    }))
    for (const changed of [
      { type: 'script' }, { message: 'another' }, { details: { reason: 'refused' } },
      { context: { ...base.context, serverId: 2 } },
      { context: { ...base.context, topic: 'b' } },
      { context: { ...base.context, command: 'subscribe' } },
    ]) expect(errorFingerprint(input({ ...base, ...changed }))).not.toBe(errorFingerprint(base))
  })

  it('serializes underlying Error causes and cyclic details safely', () => {
    const cause = new Error('original')
    const error = Object.assign(new Error('wrapper'), { cause })
    expect(stableSerialize(error)).toContain('original')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stableSerialize(cyclic)).toContain('circular')
    expect(stableSerialize(() => {})).toContain('function')
    expect(stableSerialize(NaN)).not.toBe(stableSerialize(null))
  })

  it('reduces a 1000-error burst to two IPC writes with exact delta counts and timestamps', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write)
    for (let i = 0; i < 1000; i++) {
      buffer.enqueue(input({ timestamp: new Date(Date.now() + i) }))
    }
    await buffer.flush()
    expect(write).toHaveBeenCalledTimes(2)
    const groups = write.mock.calls.flatMap(([entries]) => entries)
    expect(groups.map(metadata).map(group => group.count)).toEqual([50, 950])
    expect(metadata(groups[0])).toEqual({
      count: 50, firstTimestamp: '2026-01-01T00:00:00.000Z', lastTimestamp: '2026-01-01T00:00:00.049Z',
    })
    expect(metadata(groups[1]).lastTimestamp).toBe('2026-01-01T00:00:00.999Z')
    await buffer.flush()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('splits groups at window expiry and preserves distinct operation context', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write)
    buffer.enqueue(input({ timestamp: new Date(0), context: { serverId: 1 } }))
    buffer.enqueue(input({ timestamp: new Date(4999), context: { serverId: 1 } }))
    buffer.enqueue(input({ timestamp: new Date(5000), context: { serverId: 1 } }))
    buffer.enqueue(input({ timestamp: new Date(5001), context: { serverId: 2 } }))
    await buffer.flush()
    expect(write.mock.calls[0][0].map(metadata).map((group: { count: number }) => group.count)).toEqual([2, 1, 1])
  })

  it('flushes at occurrence threshold or timer and skips genuinely empty batches', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write)
    await buffer.flush()
    expect(write).not.toHaveBeenCalled()
    for (let i = 0; i < 49; i++) buffer.enqueue(input())
    await vi.advanceTimersByTimeAsync(999)
    expect(write).not.toHaveBeenCalled()
    buffer.enqueue(input())
    await buffer.flush()
    expect(write).toHaveBeenCalledTimes(1)
    buffer.enqueue(input())
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('retains failed batches, paces retries and never logs recursively', async () => {
    const write = vi.fn().mockRejectedValue(new Error('disk full'))
    const buffer = new ErrorLogBuffer(write)
    buffer.enqueue(input())
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 100; i++) buffer.enqueue(input())
    await vi.advanceTimersByTimeAsync(4999)
    expect(write).toHaveBeenCalledTimes(1)
    write.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(2)
    expect(metadata(write.mock.calls[1][0][0]).count).toBe(101)
    expect(console.error).toHaveBeenCalledTimes(1)
    await buffer.flush()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('explicit retry preserves in-flight and new arrivals; concurrent flush waits for all writes', async () => {
    const first = deferred()
    const second = deferred()
    const write = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise).mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write)
    buffer.enqueue(input())
    const flush = buffer.flush()
    let finished = false
    const concurrent = buffer.flush().then(() => { finished = true })
    buffer.enqueue(input())
    buffer.enqueue(input())
    first.resolve()
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    expect(metadata(write.mock.calls[1][0][0]).count).toBe(2)
    second.reject(new Error('failed'))
    await expect(flush).rejects.toThrow('failed')
    await expect(concurrent).rejects.toThrow('failed')
    expect(finished).toBe(false)
    buffer.enqueue(input())
    await buffer.flush()
    expect(metadata(write.mock.calls[2][0][0]).count).toBe(3)
  })

  it('bounds distinct groups without discarding accepted pending errors', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write, { ...options, maxGroups: 2 })
    buffer.enqueue(input({ message: 'one' }))
    buffer.enqueue(input({ message: 'two' }))
    buffer.enqueue(input({ message: 'overflow' }))
    buffer.enqueue(input({ message: 'overflow again' }))
    buffer.enqueue(input({ message: 'one' }))
    await buffer.flush()
    expect(write.mock.calls[0][0].map((entry: { message: string }) => entry.message)).toEqual(['one', 'two'])
    expect(metadata(write.mock.calls[0][0][0]).count).toBe(2)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('covers arrivals and flush calls in the final write settlement microtask', async () => {
    const first = deferred()
    const second = deferred()
    const secondStarted = deferred()
    const write = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => { secondStarted.resolve(); return second.promise })
    const buffer = new ErrorLogBuffer(write)
    buffer.enqueue(input())
    const initial = buffer.flush()
    let concurrent!: Promise<void>
    void first.promise.then(() => {
      buffer.enqueue(input())
      concurrent = buffer.flush()
    })
    let finished = false
    void initial.then(() => { finished = true })
    first.resolve()
    await secondStarted.promise
    expect(write).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    second.resolve()
    await Promise.all([initial, concurrent])
    expect(finished).toBe(true)
  })

  it('keeps a failed in-flight batch and arrivals intact for explicit retry', async () => {
    const first = deferred()
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined)
    const buffer = new ErrorLogBuffer(write)
    buffer.enqueue(input())
    const flushing = buffer.flush()
    buffer.enqueue(input())
    buffer.enqueue(input())
    first.reject(new Error('failed'))
    await expect(flushing).rejects.toThrow('failed')
    await buffer.flush()
    const groups = write.mock.calls[1][0].map(metadata)
    expect(groups.map((group: { count: number }) => group.count)).toEqual([1, 2])
    await buffer.flush()
    expect(write).toHaveBeenCalledTimes(2)
  })
})
