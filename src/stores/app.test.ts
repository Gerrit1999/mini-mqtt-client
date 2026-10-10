import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUpdaterStore } from './updater'

const mocks = vi.hoisted(() => ({
  check: vi.fn(), flush: vi.fn(), download: vi.fn(), install: vi.fn(), relaunch: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.8.0' }))
vi.mock('@/utils/errorLogBuffer', () => ({ errorLogBuffer: { flush: mocks.flush } }))
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: async () => 'confirm' } }))

describe('updater error log flushing', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    localStorage.clear()
    mocks.check.mockResolvedValue({ version: '1.9.0', download: mocks.download, install: mocks.install, close: vi.fn() })
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
    const app = useUpdaterStore()
    await app.check({ interactive: true })
    await app.download()
    expect(await app.install()).toBe(true)
    expect(order).toEqual(['download', 'flush', 'install', 'flush', 'relaunch'])
    expect(app.phase).toBe('ready')
  })

  it('waits for the pre-install flush and stops installation on failure', async () => {
    let reject!: (error: Error) => void
    mocks.flush.mockReturnValueOnce(new Promise<void>((_, no) => { reject = no }))
    const app = useUpdaterStore()
    await app.check({ interactive: true })
    await app.download()
    const installing = app.install()
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledTimes(1))
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    expect(mocks.install).not.toHaveBeenCalled()
    reject(new Error('disk full'))
    await expect(installing).rejects.toThrow('disk full')
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(app.phase).toBe('ready')
  })

  it('stops relaunch when the post-install flush fails', async () => {
    mocks.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'))
    const app = useUpdaterStore()
    await app.check({ interactive: true })
    await app.download()
    await expect(app.install()).rejects.toThrow('disk full')
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })
})
