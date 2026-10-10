import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import i18n from '@/i18n'
import UpdateStatus from './UpdateStatus.vue'
import { useUpdaterStore } from '@/stores/updater'
const native = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn() }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: native.check }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.8.1' }))

beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); vi.resetAllMocks(); native.check.mockRejectedValue(new Error('Network unavailable')) })
it('keeps ready feedback available after later and renders release notes as text', async () => {
  const updater = useUpdaterStore()
  updater.phase = 'ready'
  updater.info = { hasUpdate: true, latestVersion: 'v1.9.0', currentVersion: '1.8.1', date: '2026-10-10', body: '<img src=x onerror=alert(1)>' }
  const wrapper = mount(UpdateStatus, { global: { plugins: [createI18n({ legacy: false, missingWarn: false, fallbackWarn: false })] } })
  expect(wrapper.text()).toContain('v1.9.0')
  expect(wrapper.text()).toContain('2026-10-10')
  expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
  expect(wrapper.find('img').exists()).toBe(false)
  await wrapper.get('[data-action="later"]').trigger('click')
  expect(wrapper.get('[data-action="show"]').text()).toContain('v1.9.0')
  await wrapper.get('[data-action="show"]').trigger('click')
  expect(wrapper.find('[data-action="restart"]').exists()).toBe(true)
  wrapper.unmount()
})

it('keeps automatic check failures quiet outside settings', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const updater = useUpdaterStore()
  await updater.check()
  const wrapper = mount(UpdateStatus, { global: { plugins: [createI18n({ legacy: false, missingWarn: false, fallbackWarn: false })] } })
  expect(wrapper.find('section').exists()).toBe(false)
  expect(log).toHaveBeenCalled()
  wrapper.unmount()
  log.mockRestore()
})

it('Later in the installation confirmation settles the public install attempt without installing', async () => {
  native.check.mockResolvedValueOnce({ version: '1.9.0', download: async () => {}, install: native.install, close: async () => {} })
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  const wrapper = mount(UpdateStatus, { global: { plugins: [i18n] } })
  const installing = updater.install()
  await flushPromises()
  const later = [...document.querySelectorAll<HTMLButtonElement>('.el-message-box button')].find(button => button.textContent === 'Later')!
  later.click()
  await flushPromises()
  expect(updater.phase).toBe('ready')
  expect(await installing).toBe(false)
  expect(updater.deferred).toBe(true)
  expect(native.install).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('disposes while consent is pending without installing or leaving an unresolved close', async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  native.check.mockResolvedValueOnce({ version: '1.9.0', download: async () => {}, install: native.install, close })
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  const installing = updater.install()
  await flushPromises()
  await updater.dispose()
  expect(await installing).toBe(false)
  expect(native.install).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
  expect(updater.info).toBeNull()
})
