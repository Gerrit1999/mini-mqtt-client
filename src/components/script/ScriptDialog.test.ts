import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia } from 'pinia'
import i18n from '@/i18n'
import ScriptDialog from './ScriptDialog.vue'
import { getFunctionHelpEntries } from './functionHelp'

const writeText = vi.fn<(text: string) => Promise<void>>()
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

enableAutoUnmount(afterEach)

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

async function openFunctionHelp() {
  const wrapper = mount(ScriptDialog, {
    attachTo: document.body,
    props: { visible: true, serverId: 0 },
    global: {
      plugins: [ElementPlus, i18n, createPinia()],
      stubs: {
        ElDialog: {
          props: ['modelValue'],
          template: '<div v-if="modelValue"><slot /></div>',
        },
      },
    },
  })
  await wrapper.findAll('button').find(button => button.text() === 'Add Script')!.trigger('click')
  await wrapper.findAll('button').find(button => button.text() === 'Available Functions')!.trigger('click')
  return wrapper
}

it('copies each selected signature and keeps data references as plain text', async () => {
  const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }))
  const wrapper = await openFunctionHelp()
  const signatures = [
    'JSON.parse(str)',
    'await crypto.hmacSha256(key, data)',
    'pako.gzip(data, options?)',
    'env.get("VAR_NAME")',
  ]

  expect(wrapper.text()).toContain('Click a function or press Enter or Space')
  for (const signature of signatures) {
    const button = wrapper.findAll('button').find(button => button.attributes('aria-label') === `Copy ${signature}`)!
    expect(button.text()).toBe(signature)
    expect(button.attributes('title')).toBe(`Copy ${signature}`)
    expect(button.attributes('type')).toBe('button')
    button.element.focus()
    expect(document.activeElement).toBe(button.element)
    await button.trigger('click')
  }
  await flushPromises()

  expect(writeText.mock.calls).toEqual(signatures.map(signature => [signature]))
  expect(success.mock.calls).toEqual(signatures.map(() => ['Copied to clipboard']))
  for (const value of ['payloadBytes', 'env.VAR_NAME']) {
    expect(wrapper.get('.function-list').text()).toContain(value)
    expect(wrapper.find(`button[aria-label="Copy ${value}"]`).exists()).toBe(false)
  }
})

it('shows a failure message when the clipboard write is rejected', async () => {
  writeText.mockRejectedValueOnce(new Error('Clipboard access denied'))
  const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }))
  const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }))
  const wrapper = await openFunctionHelp()

  await wrapper.get('button[aria-label="Copy pako.inflate(data, options?)"]').trigger('click')
  await flushPromises()

  expect(writeText).toHaveBeenCalledExactlyOnceWith('pako.inflate(data, options?)')
  expect(error).toHaveBeenCalledExactlyOnceWith('Copy failed')
  expect(success).not.toHaveBeenCalled()
})

it('expands shorthand method names into individually copyable signatures', () => {
  expect(getFunctionHelpEntries('crypto.bytesToBase64(bytes) / base64ToBytes(str)')).toEqual([
    { text: 'crypto.bytesToBase64(bytes)', copyable: true },
    { text: 'crypto.base64ToBytes(str)', copyable: true },
  ])
  expect(getFunctionHelpEntries('await crypto.sha256(data) / await sha1(data) / JSON.parse(str)')).toEqual([
    { text: 'await crypto.sha256(data)', copyable: true },
    { text: 'await crypto.sha1(data)', copyable: true },
    { text: 'JSON.parse(str)', copyable: true },
  ])
})

it('renders built-in object summaries as plain text', () => {
  expect(getFunctionHelpEntries('JSON, Math, Date, ...')).toEqual([
    { text: 'JSON, Math, Date, ...', copyable: false },
  ])
})
