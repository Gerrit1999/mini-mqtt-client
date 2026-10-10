import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import ElementPlus, { ElInput, ElDialog, ElButton } from 'element-plus'
import { useUpdaterStore } from '@/stores/updater'
import PublishPanel from '@/components/mqtt/PublishPanel.vue'
import i18n from '@/i18n'
import EnvDialog from '@/components/env/EnvDialog.vue'
import TemplateDialog from '@/components/template/TemplateDialog.vue'
import ServerFormDialog from '@/components/mqtt/ServerFormDialog.vue'
import ScriptDialog from '@/components/script/ScriptDialog.vue'
import App from '@/App.vue'
import ScheduledPublishDialog from '@/components/mqtt/ScheduledPublishDialog.vue'
import MainContent from '@/components/mqtt/MainContent.vue'
import { type Script } from '@/stores/script'

const native = vi.hoisted(() => ({ confirm: vi.fn(), install: vi.fn(), invoke: vi.fn() }))
vi.mock('element-plus', async importOriginal => ({
  ...await importOriginal<typeof import('element-plus')>(),
  ElMessageBox: { confirm: native.confirm },
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => ({ version: '1.9.0', download: async () => {}, install: native.install, close: async () => {} }) }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.8.1' }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))

beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); vi.resetAllMocks(); native.invoke.mockResolvedValue([]) })
afterEach(() => vi.restoreAllMocks())
const global = { plugins: [ElementPlus, i18n] }
function confirmationText() {
  const message = native.confirm.mock.calls.at(-1)![0]
  const wrapper = mount(defineComponent({ render: () => h('div', [message]) }))
  const text = wrapper.text()
  wrapper.unmount()
  return text
}

it('protects a changed publish draft even while collapsed, but releases it when unmounted', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(PublishPanel, { props: { collapsed: false, scheduledPublishRunning: false, timedMessageRunning: false }, global })
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved publish draft')
  wrapper.findAllComponents(ElInput)[0].vm.$emit('update:modelValue', 'draft/topic')
  await wrapper.setProps({ collapsed: true })
  await flushPromises()
  await updater.install()
  expect(confirmationText()).toContain('Unsaved publish draft')
  expect(native.install).not.toHaveBeenCalled()
  wrapper.unmount()
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved publish draft')
})

it('protects changed environment fields, but opening unchanged data and cancelling do not block', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(EnvDialog, { props: { visible: false, variable: { id: 1, server_id: 1, name: 'DEVICE', value: 'original' }, serverId: 1 }, global: { ...global, renderStubDefaultSlot: true } })
  await wrapper.setProps({ visible: true })
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved environment variable')
  wrapper.findAllComponents(ElInput)[1].vm.$emit('update:modelValue', 'new value')
  await updater.install()
  expect(confirmationText()).toContain('Unsaved environment variable')
  await wrapper.setProps({ visible: false })
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved environment variable')
  wrapper.unmount()
})

it('protects template edits and clears the warning when reset by reopening', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(TemplateDialog, { props: { visible: false, template: null, serverId: 1, categories: [] }, global: { ...global, renderStubDefaultSlot: true, stubs: { ElForm: false } } })
  await wrapper.setProps({ visible: true })
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved template')
  wrapper.findAllComponents(ElInput)[0].vm.$emit('update:modelValue', 'My template')
  await updater.install()
  expect(confirmationText()).toContain('Unsaved template')
  await wrapper.setProps({ visible: false })
  await wrapper.setProps({ visible: true })
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved template')
  wrapper.unmount()
})

it('protects changed server configuration without flagging unchanged preloaded fields', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(ServerFormDialog, { props: { visible: false, server: { id: 1, name: 'Production', host: 'example.com', port: 8883, protocol: 'mqtts', protocol_version: '5.0', keep_alive: 60, clean_session: true, use_tls: true } }, global: { ...global, renderStubDefaultSlot: true } })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved server configuration')
  wrapper.findAllComponents(ElInput)[0].vm.$emit('update:modelValue', 'Renamed')
  await updater.install()
  expect(confirmationText()).toContain('Unsaved server configuration')
  wrapper.unmount()
})

it('protects changed script code without flagging a default new script', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(ScriptDialog, { props: { visible: true, serverId: 1 }, global: { ...global, renderStubDefaultSlot: true } })
  wrapper.findAllComponents(ElDialog)[0].vm.$emit('open')
  await flushPromises()
  await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Add Script')!.trigger('click')
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved script')
  wrapper.findAllComponents(ElInput).at(-1)!.vm.$emit('update:modelValue', 'return payload + "new"')
  await updater.install()
  expect(confirmationText()).toContain('Unsaved script')
  wrapper.unmount()
})

it('clears saved environment edits while retaining edits made during an asynchronous save', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(EnvDialog, { props: { visible: false, variable: { id: 1, server_id: 1, name: 'DEVICE', value: 'original' }, serverId: 1 }, global: { ...global, renderStubDefaultSlot: true, stubs: { ElForm: false, ElDialog: { name: 'ElDialog', template: '<div><slot/><slot name="footer"/></div>' } } } })
  await wrapper.setProps({ visible: true })
  wrapper.findAllComponents(ElInput)[1].vm.$emit('update:modelValue', 'saved value')
  let finish!: () => void
  native.invoke.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!.trigger('click')
  await flushPromises()
  wrapper.findAllComponents(ElInput)[1].vm.$emit('update:modelValue', 'new unsaved value')
  finish()
  await flushPromises()
  await updater.install()
  expect(confirmationText()).toContain('Unsaved environment variable')
  await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!.trigger('click')
  await flushPromises()
  await updater.install()
  expect(confirmationText()).not.toContain('Unsaved environment variable')
  wrapper.unmount()
})

it.each([false, true])('retains the created script editor and protects later edits (changed during create: %s)', async changed => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(ScriptDialog, { props: { visible: true, serverId: 1 }, global: { ...global, renderStubDefaultSlot: true } })
  try {
    wrapper.findAllComponents(ElDialog)[0].vm.$emit('open')
    await flushPromises()
    await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Add Script')!.trigger('click')
    wrapper.findAllComponents(ElInput)[0].vm.$emit('update:modelValue', 'Created script')
    wrapper.findAllComponents(ElInput)[2].vm.$emit('update:modelValue', 'submitted code')
    let finish!: (id: number) => void
    const created: Script = { id: 7, server_id: 1, name: 'Created script', script_type: 'before_publish', code: 'submitted code', enabled: true }
    native.invoke.mockImplementation(async (command: string) => command === 'list_scripts' ? [created] : undefined)
    native.invoke.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve }))
    await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!.trigger('click')
    if (changed) wrapper.findAllComponents(ElInput)[2].vm.$emit('update:modelValue', 'later code')
    finish(created.id!)
    await flushPromises()
    await updater.install()
    if (changed) expect(confirmationText()).toContain('Unsaved script')
    else expect(confirmationText()).not.toContain('Unsaved script')
    expect(wrapper.findAllComponents(ElInput)[2].props('modelValue')).toBe(changed ? 'later code' : 'submitted code')
    expect(wrapper.find('.script-item.active').text()).toContain('Created script')
    await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(native.invoke).toHaveBeenCalledWith('update_script', { request: { id: 7, name: 'Created script', code: changed ? 'later code' : 'submitted code', description: undefined } })
    await updater.install()
    expect(confirmationText()).not.toContain('Unsaved script')
  } finally {
    wrapper.unmount()
  }
})

it('does not replace another selected script or its baseline when creation finishes', async () => {
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const existing: Script = { id: 3, server_id: 1, name: 'Existing script', script_type: 'before_publish', code: 'existing code', enabled: true }
  native.invoke.mockResolvedValue([existing])
  const wrapper = shallowMount(ScriptDialog, { props: { visible: true, serverId: 1 }, global: { ...global, renderStubDefaultSlot: true } })
  try {
    wrapper.findAllComponents(ElDialog)[0].vm.$emit('open')
    await flushPromises()
    await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Add Script')!.trigger('click')
    wrapper.findAllComponents(ElInput)[0].vm.$emit('update:modelValue', 'Created script')
    let finish!: (id: number) => void
    native.invoke.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve }))
    await wrapper.findAllComponents(ElButton).find(button => button.text() === 'Save')!.trigger('click')
    await wrapper.find('.script-item').trigger('click')
    finish(7)
    await flushPromises()
    expect(wrapper.find('.script-item.active').text()).toContain('Existing script')
    expect(wrapper.findAllComponents(ElInput)[2].props('modelValue')).toBe('existing code')
    await updater.install()
    expect(confirmationText()).not.toContain('Unsaved script')
    wrapper.findAllComponents(ElInput)[2].vm.$emit('update:modelValue', 'edited existing code')
    await updater.install()
    expect(confirmationText()).toContain('Unsaved script')
  } finally {
    wrapper.unmount()
  }
})

it('protects scheduled publishing and timed messages when their dialogs are hidden', async () => {
  localStorage.setItem('mqtt-client-theme', 'light')
  const updater = useUpdaterStore()
  await updater.check()
  await updater.download()
  native.confirm.mockRejectedValue('cancel')
  const wrapper = shallowMount(App, { global: { ...global, renderStubDefaultSlot: true } })
  await flushPromises()
  wrapper.getComponent(ScheduledPublishDialog).vm.$emit('running-change', true)
  wrapper.getComponent(MainContent).vm.$emit('update:timed-message-running', true)
  expect(wrapper.getComponent(ScheduledPublishDialog).props('visible')).toBe(false)
  await updater.install()
  expect(confirmationText()).toContain('Scheduled publishing will stop')
  expect(confirmationText()).toContain('Timed messages will stop')
  expect(native.install).not.toHaveBeenCalled()
  wrapper.unmount()
  await flushPromises()
})
