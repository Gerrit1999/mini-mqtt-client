import { invoke } from '@tauri-apps/api/core'

export interface ErrorLogInput {
  type: string
  message: string
  details?: unknown
  context?: Record<string, unknown>
  timestamp: Date
}

export interface ErrorLogEntry {
  type: string
  message: string
  details: string | null
  timestamp: string
}

// Sorted object keys make context independent of insertion order. Error causes,
// including non-enumerable Error fields, survive serialization; cycles are safe.
export function stableSerialize(value: unknown): string {
  const ancestors = new Set<object>()
  function normalize(value: unknown): unknown {
    if (typeof value === 'bigint') return { bigint: String(value) }
    if (typeof value === 'symbol') return { symbol: String(value) }
    if (typeof value === 'function') return { function: String(value) }
    if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) }
    if (value === undefined) return { undefined: true }
    if (typeof value !== 'object' || value === null) return value
    if (ancestors.has(value)) return { circular: true }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? { date: 'Invalid Date' } : value.toISOString()
    ancestors.add(value)
    const source = value instanceof Error
      ? { ...value, name: value.name, message: value.message, stack: value.stack,
          cause: (value as Error & { cause?: unknown }).cause }
      : value
    const result = Array.isArray(source)
      ? source.map(normalize)
      : Object.fromEntries(Object.keys(source).sort().map(key =>
          [key, normalize((source as Record<string, unknown>)[key])]))
    ancestors.delete(value)
    return result
  }
  return JSON.stringify(normalize(value))
}

export function errorFingerprint(error: ErrorLogInput): string {
  // Use the canonical value directly, avoiding hash collisions and timestamps.
  return stableSerialize([error.type, error.message, error.details, error.context])
}

interface Group {
  fingerprint: string
  entry: ErrorLogEntry
  details: unknown
  context: unknown
  count: number
  first: number
  last: number
}

/**
 * Disk groups cover only unsent occurrences within 5s of their first occurrence.
 * Each committed row is a delta (count/firstTimestamp/lastTimestamp), never a
 * cumulative rewrite. In-flight groups are immutable; later arrivals form new
 * deltas. UI memory independently retains the latest 100 individual occurrences.
 */
export class ErrorLogBuffer {
  private pending: Group[] = []
  private inFlightCount = 0
  private active?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private retryAt = 0
  private overflowReported = false

  constructor(
    private write: (entries: ErrorLogEntry[]) => Promise<unknown> = entries =>
      invoke('write_error_logs', { entries }),
    private options = { threshold: 50, flushMs: 1000, windowMs: 5000, maxGroups: 1000, retryMs: 5000 }
  ) {}

  enqueue(error: ErrorLogInput): void {
    const fingerprint = errorFingerprint(error)
    const now = error.timestamp.getTime()
    const group = this.pending.slice(this.inFlightCount).find(group =>
      group.fingerprint === fingerprint && now >= group.first && now - group.first < this.options.windowMs)
    if (group) {
      group.count++
      group.last = Math.max(group.last, now)
    } else if (this.pending.length < this.options.maxGroups) {
      this.pending.push({
        fingerprint,
        entry: { type: error.type, message: error.message, details: null, timestamp: error.timestamp.toISOString() },
        details: error.details === undefined ? null : JSON.parse(stableSerialize(error.details)),
        context: error.context === undefined ? null : JSON.parse(stableSerialize(error.context)),
        count: 1, first: now, last: now,
      })
    } else {
      // Preserve accepted data during prolonged failures; reject newest distinct
      // groups at the cap and report out-of-band instead of recursively logging.
      if (!this.overflowReported) console.error('错误日志缓冲区已满，新错误未写入磁盘')
      this.overflowReported = true
    }
    const occurrences = this.pending.slice(this.inFlightCount).reduce((sum, group) => sum + group.count, 0)
    if (!this.active && Date.now() >= this.retryAt && occurrences >= this.options.threshold) {
      this.flushAutomatically()
    } else {
      this.schedule()
    }
  }

  // Concurrent callers share the entire drain, including arrivals during writes.
  // An explicit flush can retry immediately; background retries are paced.
  async flush(): Promise<void> {
    do {
      if (!this.active) {
        if (!this.pending.length) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        this.active = this.drain().finally(() => {
          this.active = undefined
          this.inFlightCount = 0
          this.schedule()
        })
      }
      await this.active
      // Arrivals can land between drain's final write and its promise cleanup.
      // Re-check after awaiting so a concurrent flush also covers those entries.
    } while (this.pending.length)
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.slice(0, this.options.threshold)
      this.inFlightCount = batch.length
      const entries = batch.map(group => ({
        ...group.entry,
        details: stableSerialize({ details: group.details, context: group.context, aggregation: {
          count: group.count,
          firstTimestamp: new Date(group.first).toISOString(),
          lastTimestamp: new Date(group.last).toISOString(),
        } }),
      }))
      try {
        await this.write(entries)
      } catch (error) {
        this.retryAt = Date.now() + this.options.retryMs
        throw error
      }
      this.pending.splice(0, batch.length)
      this.inFlightCount = 0
      this.retryAt = 0
      this.overflowReported = false
    }
  }

  private flushAutomatically(): void {
    void this.flush().catch(error => console.error('写入日志文件失败，保留缓冲区等待重试:', error))
  }

  private schedule(): void {
    if (this.timer || this.active || !this.pending.length) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushAutomatically()
    }, Math.max(this.options.flushMs, this.retryAt - Date.now()))
  }
}

export const errorLogBuffer = new ErrorLogBuffer()
