import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { errorHandler, ErrorType } from './errorHandler'
import { handleMqttError } from './mqttErrorHandler'
import { ScriptEngine } from './scriptEngine'
import type { ErrorLogEntry } from './errorLogBuffer'

const entriesOf = (args: unknown) => (args as { entries: ErrorLogEntry[] }).entries

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('element-plus', () => ({ ElNotification: vi.fn() }))

describe('error handler persistence contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined)
    errorHandler.clearErrors()
    errorHandler.setLogToFileEnabled(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    await errorHandler.flush()
    errorHandler.clearErrors()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps bounded UI occurrences while disk aggregates, and UI clearing preserves pending logs', async () => {
    for (let i = 0; i < 120; i++) errorHandler.handle('same', ErrorType.MQTT, true)
    expect(errorHandler.getErrorCount()).toBe(100)
    expect(errorHandler.getErrorsByType(ErrorType.MQTT)).toHaveLength(100)
    errorHandler.clearErrors()
    expect(errorHandler.getLatestError()).toBeNull()
    await errorHandler.flush()
    const entries = vi.mocked(invoke).mock.calls.flatMap(([, args]) => entriesOf(args))
    expect(entries.reduce((sum, entry) => sum + JSON.parse(entry.details!).aggregation.count, 0)).toBe(120)
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'write_error_logs')).toBe(true)
  })

  it('preserves distinct raw MQTT reasons behind the same friendly message', async () => {
    handleMqttError('connection refused: host A')
    handleMqttError('connection refused: host B')
    expect(errorHandler.getErrors()[0].message).toBe(errorHandler.getErrors()[1].message)
    await errorHandler.flush()
    const entries = entriesOf(vi.mocked(invoke).mock.calls[0][1])
    expect(entries).toHaveLength(2)
    expect(JSON.parse(entries[0].details!).details.reason).toBe('connection refused: host A')
    expect(JSON.parse(entries[1].details!).details.reason).toBe('connection refused: host B')
  })

  it('keeps original script causes and available server, topic and command context', async () => {
    const script = {
      id: 42, server_id: 7, name: 'test', enabled: true,
      script_type: 'before_publish' as const, code: 'throw new Error("underlying reason")',
    }
    const beforeError = await ScriptEngine.executeBeforePublish([script], 'body', 'out').catch(error => error)
    const afterError = await ScriptEngine.executeAfterReceive([{ ...script, script_type: 'after_receive' }], 'body', 'in')
      .catch(error => error)
    expect(beforeError).toMatchObject({ message: 'underlying reason', scriptId: 42, scriptName: 'test' })
    expect(afterError).toMatchObject({ message: 'underlying reason', scriptId: 42, scriptName: 'test' })
    expect(errorHandler.getErrorCount()).toBe(0)
    // The caller supplies actual request context and persists the forwarded cause once.
    errorHandler.handle(beforeError, ErrorType.SCRIPT, true, { serverId: 7, topic: 'out', command: 'before_publish', scriptId: beforeError.scriptId })
    errorHandler.handle(afterError, ErrorType.SCRIPT, true, { serverId: 7, topic: 'in', command: 'after_receive', scriptId: afterError.scriptId })
    await errorHandler.flush()
    const entries = entriesOf(vi.mocked(invoke).mock.calls[0][1])
    const details = entries.map(entry => JSON.parse(entry.details!))
    expect(details[0].context).toEqual({ serverId: 7, topic: 'out', command: 'before_publish', scriptId: 42 })
    expect(details[1].context).toEqual({ serverId: 7, topic: 'in', command: 'after_receive', scriptId: 42 })
    expect(details[0].details.cause.message).toBe('underlying reason')
    expect(details[1].details.cause.message).toBe('underlying reason')
  })

  it('disabling file logging affects future occurrences without discarding accepted data', async () => {
    errorHandler.handle('accepted', ErrorType.UNKNOWN, true)
    errorHandler.setLogToFileEnabled(false)
    errorHandler.handle('UI only', ErrorType.UNKNOWN, true)
    await errorHandler.flush()
    expect(entriesOf(vi.mocked(invoke).mock.calls[0][1]).map(entry => entry.message)).toEqual(['accepted'])
    expect(errorHandler.getErrorCount()).toBe(2)
  })
})

