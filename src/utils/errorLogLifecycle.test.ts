import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupErrorLogLifecycle } from './errorLogLifecycle'

const mocks = vi.hoisted(() => ({
  flush: vi.fn(), destroy: vi.fn(), listen: vi.fn(), notify: vi.fn(), isTauri: vi.fn(),
}))
vi.mock('./errorLogBuffer', () => ({ errorLogBuffer: { flush: mocks.flush } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.listen, destroy: mocks.destroy }),
}))
vi.mock('element-plus', () => ({ ElNotification: mocks.notify }))

describe('error logging exit lifecycle', () => {
  let cleanup: (() => void) | undefined
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.isTauri.mockReturnValue(true)
    mocks.flush.mockResolvedValue(undefined)
    mocks.destroy.mockResolvedValue(undefined)
    mocks.listen.mockResolvedValue(vi.fn())
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks() })

  it('registers native close and waits for persistence before destroying the window', async () => {
    let finish!: () => void
    mocks.flush.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    cleanup = await setupErrorLogLifecycle()
    const close = mocks.listen.mock.calls[0][0]
    const event = { preventDefault: vi.fn() }
    const closing = close(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(mocks.destroy).not.toHaveBeenCalled()
    await close({ preventDefault: vi.fn() })
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    finish()
    await closing
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('reports failed flushing without closing or recursive logging, and permits a later retry', async () => {
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    cleanup = await setupErrorLogLifecycle()
    const close = mocks.listen.mock.calls[0][0]
    await close({ preventDefault: vi.fn() })
    expect(mocks.destroy).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    await close({ preventDefault: vi.fn() })
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('handles native destroy and listener setup failures out of band', async () => {
    mocks.destroy.mockRejectedValueOnce(new Error('close denied'))
    cleanup = await setupErrorLogLifecycle()
    await mocks.listen.mock.calls[0][0]({ preventDefault: vi.fn() })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    cleanup()
    mocks.listen.mockRejectedValueOnce(new Error('listen denied'))
    cleanup = await setupErrorLogLifecycle()
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })

  it('installs a best-effort browser beforeunload fallback and removes it on cleanup', async () => {
    mocks.isTauri.mockReturnValue(false)
    cleanup = await setupErrorLogLifecycle()
    expect(mocks.listen).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    mocks.flush.mockRejectedValueOnce(new Error('unload failed'))
    window.dispatchEvent(new Event('beforeunload'))
    await Promise.resolve()
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    cleanup()
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.flush).toHaveBeenCalledTimes(2)
  })
})

