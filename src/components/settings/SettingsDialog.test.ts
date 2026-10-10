import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, shallowMount, mount } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElSwitch, ElButton, ElMessage, ElMessageBox } from 'element-plus'
import { defineComponent, h, type VNode } from 'vue'
import i18n, { loadLocaleMessages } from '@/i18n'
import SettingsDialog from './SettingsDialog.vue'
import { useUpdaterStore } from '@/stores/updater'

vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.8.1' }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => ({ version: '1.9.0', body: 'Release notes', download: async () => {}, close: async () => {} }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string) => command === 'get_app_settings' ? {
  message_limit: 1000, mqtt_packet_size_limit_kb: 1024, message_retention_days: 30, message_retention_count: 100000,
} : '/data' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ theme: async () => 'light', onThemeChanged: async () => () => {} }) }))
beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })
afterEach(() => vi.restoreAllMocks())

it.each(['en-US', 'zh-CN'] as const)('shows the actual skipped version after a manual settings check (%s)', async locale => {
  localStorage.setItem('mqtt-client-update-skipped-version', '1.9.0')
  const previousLocale = i18n.global.locale.value
  await loadLocaleMessages(locale)
  i18n.global.locale.value = locale
  const feedback = vi.spyOn(ElMessage, 'success')
  const updater = useUpdaterStore()
  const wrapper = shallowMount(SettingsDialog, { props: { visible: true }, global: { renderStubDefaultSlot: true, stubs: { ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' }, UpdateStatus: false }, plugins: [ElementPlus, i18n] } })
  try {
    await wrapper.findAllComponents(ElButton).find(button => button.text() === i18n.global.t('settings.update.check'))!.trigger('click')
    await flushPromises()
    const status = wrapper.get('.update-status').text()
    expect(status).toBe(locale === 'en-US' ? 'Version v1.9.0 is available but you skipped it' : '发现版本 v1.9.0，但您已跳过此版本')
    expect(feedback).toHaveBeenCalledExactlyOnceWith(status)
    expect(status).not.toContain(i18n.global.t('settings.update.upToDate'))
    expect(updater.info?.latestVersion).toBe('v1.9.0')
    expect(updater.skippedVersion).toBe('1.9.0')
    expect(wrapper.find('[data-action="download"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="restart"]').exists()).toBe(false)
    expect(wrapper.find('.update-status-card').exists()).toBe(false)
  } finally {
    wrapper.unmount()
    await updater.dispose()
    i18n.global.locale.value = previousLocale
  }
})

it('preserves downloaded metadata when settings opens and saves update preferences only on Save', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  const wrapper = shallowMount(SettingsDialog, { props: { visible: true }, global: { renderStubDefaultSlot: true, stubs: { ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' } }, plugins: [ElementPlus, i18n] } })
  wrapper.getComponent(ElDialog).vm.$emit('open')
  await flushPromises()
  expect(updater.info?.latestVersion).toBe('v1.9.0')
  expect(updater.phase).toBe('ready')
  expect(updater.canInstall).toBe(true)
  const switches = wrapper.findAllComponents(ElSwitch)
  switches[0].vm.$emit('update:modelValue', false)
  switches[1].vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(updater.autoCheck).toBe(true)
  const save = wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!
  await save.trigger('click')
  await flushPromises()
  expect(updater.autoCheck).toBe(false)
  expect(updater.autoDownload).toBe(false)
  expect(localStorage.getItem('mqtt-client-update-auto-download')).toBe('false')
  expect(updater.info?.latestVersion).toBe('v1.9.0')
  wrapper.unmount()
})

it('discards staged update preferences on Cancel without discarding the ready update', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  const wrapper = shallowMount(SettingsDialog, { props: { visible: true }, global: { renderStubDefaultSlot: true, stubs: { ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' } }, plugins: [ElementPlus, i18n] } })
  wrapper.getComponent(ElDialog).vm.$emit('open')
  await flushPromises()
  wrapper.findAllComponents(ElSwitch)[0].vm.$emit('update:modelValue', false)
  await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Cancel')!.trigger('click')
  expect(updater.autoCheck).toBe(true)
  expect(updater.canInstall).toBe(true)
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
  wrapper.unmount()
})

it('lists unsaved settings in public installation protection only after a setting actually changes', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
  const wrapper = shallowMount(SettingsDialog, { props: { visible: true }, global: { renderStubDefaultSlot: true, stubs: { ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' } }, plugins: [ElementPlus, i18n] } })
  wrapper.getComponent(ElDialog).vm.$emit('open')
  await flushPromises()
  const messageText = () => {
    const message = mount(defineComponent({ render: () => h('div', [confirm.mock.calls.at(-1)![0] as VNode]) }))
    const text = message.text()
    message.unmount()
    return text
  }
  await updater.install()
  expect(messageText()).not.toContain('Unsaved settings')
  wrapper.findAllComponents(ElSwitch)[1].vm.$emit('update:modelValue', false)
  await updater.install()
  expect(messageText()).toContain('Unsaved settings')
  await wrapper.setProps({ visible: false })
  await updater.install()
  expect(messageText()).not.toContain('Unsaved settings')
  wrapper.unmount()
})

it('closing with the dialog close control resets staged update switches', async () => {
  const updater = useUpdaterStore()
  const wrapper = shallowMount(SettingsDialog, { props: { visible: true }, global: { renderStubDefaultSlot: true, stubs: { ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' } }, plugins: [ElementPlus, i18n] } })
  wrapper.getComponent(ElDialog).vm.$emit('open')
  await flushPromises()
  wrapper.findAllComponents(ElSwitch)[0].vm.$emit('update:modelValue', false)
  wrapper.getComponent(ElDialog).vm.$emit('close')
  await flushPromises()
  expect(wrapper.findAllComponents(ElSwitch)[0].props('modelValue')).toBe(true)
  expect(updater.autoCheck).toBe(true)
  wrapper.unmount()
})
