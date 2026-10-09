import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from './app'

const mocks = vi.hoisted(() => ({
  check: vi.fn(), flush: vi.fn(), download: vi.fn(), install: vi.fn(), relaunch: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.8.0' }))
vi.mock('@/utils/errorLogBuffer', () => ({ errorLogBuffer: { flush: mocks.flush } }))

describe('updater error log flushing', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    mocks.check.mockResolvedValue({ version: '1.9.0', download: mocks.download, install: mocks.install })
    mocks.flush.mockResolvedValue(undefined)
    mocks.download.mockResolvedValue(undefined)
    mocks.install.mockResolvedValue(undefined)
    mocks.relaunch.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('flushes after download before installation and again before relaunch', async () => {
    const order: string[] = []
    mocks.download.mockImplementation(async () => { order.push('download') })
    mocks.flush.mockImplementation(async () => { order.push('flush') })
    mocks.install.mockImplementation(async () => { order.push('install') })
    mocks.relaunch.mockImplementation(async () => { order.push('relaunch') })
    const app = useAppStore()
    await app.checkUpdate()
    expect(await app.installUpdate()).toBe(true)
    expect(order).toEqual(['download', 'flush', 'install', 'flush', 'relaunch'])
    expect(app.installingUpdate).toBe(false)
  })

  it('waits for the pre-install flush and stops installation on failure', async () => {
    let reject!: (error: Error) => void
    mocks.flush.mockReturnValueOnce(new Promise<void>((_, no) => { reject = no }))
    const app = useAppStore()
    await app.checkUpdate()
    const installing = app.installUpdate()
    await Promise.resolve()
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    expect(mocks.install).not.toHaveBeenCalled()
    reject(new Error('disk full'))
    await expect(installing).rejects.toThrow('disk full')
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(app.installingUpdate).toBe(false)
  })

  it('stops relaunch when the post-install flush fails', async () => {
    mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'))
    const app = useAppStore()
    await app.checkUpdate()
    await expect(app.installUpdate()).rejects.toThrow('disk full')
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })
})
