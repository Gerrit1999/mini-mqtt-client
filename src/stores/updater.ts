import { defineStore } from 'pinia'
import { computed, h, ref } from 'vue'
import { check as nativeCheck, type Update } from '@tauri-apps/plugin-updater'
import { getVersion } from '@tauri-apps/api/app'
import { ElMessage, ElMessageBox } from 'element-plus'
import i18n from '@/i18n'
import { relaunch } from '@tauri-apps/plugin-process'
import { errorLogBuffer } from '@/utils/errorLogBuffer'
import { useMqttStore } from './mqtt'
import { getUpdateImpacts } from '@/composables/useUpdateProtection'

export const useUpdaterStore = defineStore('updater', () => {
  const phase = ref<'idle' | 'checking' | 'available' | 'skipped' | 'up_to_date' | 'downloading' | 'ready' | 'installing'>('idle')
  const info = ref<{ hasUpdate: boolean; latestVersion: string; currentVersion: string; date?: string; body?: string } | null>(null)
  const progress = ref<number | null>(null)
  const error = ref('')
  const errorVisible = ref(false)
  const deferred = ref(false)
  const autoCheck = ref(localStorage.getItem('mqtt-client-update-auto-check') !== 'false')
  const autoDownload = ref(localStorage.getItem('mqtt-client-update-auto-download') !== 'false')
  const skippedVersion = ref(localStorage.getItem('mqtt-client-update-skipped-version') || '')
  const timestamp = Number(localStorage.getItem('mqtt-client-update-last-checked-at'))
  const lastCheckedAt = ref(Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() ? timestamp : 0)
  let pending: Update | null = null
  let downloaded = false
  let installed = false
  let generation = 0
  const closed = new WeakSet<Update>()
  const resources = new Set<Update>()
  const closing = new Map<Update, Promise<void>>()
  const canDownload = computed(() => !!info.value?.hasUpdate && !downloaded && phase.value === 'available')
  const canInstall = computed(() => !!info.value?.hasUpdate && downloaded && phase.value === 'ready')
  let timer: ReturnType<typeof setTimeout> | undefined
  let initialized = false
  let disposed = false
  let checking: Promise<typeof info.value> | undefined
  let downloading: Promise<boolean> | undefined
  let installing: Promise<boolean> | undefined
  let disposing: Promise<void> | undefined
  let cancelConfirmation: (() => void) | undefined
  async function close(update: Update | null) {
    if (!update || closed.has(update)) return
    const active = closing.get(update)
    if (active) return active
    const operation = update.close().then(() => {
      closed.add(update)
      resources.delete(update)
    }).finally(() => { closing.delete(update) })
    closing.set(update, operation)
    return operation
  }
  function fail(cause: unknown, interactive: boolean, key: string) {
    error.value = String(cause)
    errorVisible.value ||= interactive
    console.error('Updater:', cause)
    if (interactive) ElMessage.error(`${i18n.global.t(key)}: ${cause}`)
  }
  function setPreferences(settings: { autoCheck: boolean; autoDownload: boolean }) {
    autoCheck.value = settings.autoCheck
    autoDownload.value = settings.autoDownload
    localStorage.setItem('mqtt-client-update-auto-check', String(settings.autoCheck))
    localStorage.setItem('mqtt-client-update-auto-download', String(settings.autoDownload))
  }
  async function check({ interactive = false } = {}) {
    const now = Date.now()
    const requestGeneration = generation
    if (disposed) return null
    if (downloading || phase.value === 'installing') {
      if (interactive) ElMessage.success(i18n.global.t('settings.update.newVersion'))
      return info.value
    }
    if (!checking) {
      if (!interactive && (!autoCheck.value || (lastCheckedAt.value > 0 && now >= lastCheckedAt.value && now - lastCheckedAt.value < 86400000))) return info.value
      lastCheckedAt.value = now
      localStorage.setItem('mqtt-client-update-last-checked-at', String(now))
      const previous = phase.value
      const token = generation
      error.value = ''
      errorVisible.value = false
      phase.value = 'checking'
      checking = (async () => {
        let update: Update | null = null
        try {
          const currentVersion = await getVersion()
          update = await nativeCheck({ timeout: 30000 })
          if (update) resources.add(update)
          if (disposed || token !== generation) { await close(update); return info.value }
          const candidate = update
          const skipped = !!update && update.version === skippedVersion.value
          if (skipped) { await close(update); update = null }
          // Rechecking the same version must retain downloaded bytes and retryability.
          if (pending && update?.version === pending.version) {
            if (update !== pending) await close(update)
            if (disposed || token !== generation) return info.value
            phase.value = downloaded ? 'ready' : 'available'
          } else {
            await close(pending)
            if (disposed || token !== generation) { await close(update); return info.value }
            pending = update
            downloaded = false
            installed = false
            progress.value = null
            info.value = { hasUpdate: !!update, latestVersion: candidate ? `v${candidate.version}` : `v${currentVersion}`, currentVersion, date: candidate?.date, body: candidate?.body }
            phase.value = skipped ? 'skipped' : update ? 'available' : 'up_to_date'
            deferred.value = false
          }
          return info.value
        } catch (cause) {
          if (update !== pending) {
            try { await close(update) } catch (cleanupError) { console.error('Updater cleanup:', cleanupError) }
          }
          if (!disposed && token === generation) { phase.value = previous; error.value = String(cause) }
          throw cause
        }
      })().finally(() => { checking = undefined })
    }
    try {
      const result = await checking
      if (disposed || requestGeneration !== generation) return null
      if (interactive) ElMessage.success(phase.value === 'skipped'
        ? i18n.global.t('settings.update.skipped', { version: result?.latestVersion })
        : i18n.global.t(result?.hasUpdate ? 'settings.update.newVersion' : 'settings.update.upToDate'))
      if (autoDownload.value && canDownload.value) void download({ interactive: false })
      return result
    } catch (cause) {
      if (!disposed && requestGeneration === generation) fail(cause, interactive, 'errors.checkUpdateFailed')
      if (interactive) throw cause
      return null
    }
  }
  async function download({ interactive = true } = {}) {
    if (downloading) {
      const token = generation
      const result = await downloading
      if (!result && interactive && !disposed && token === generation && error.value) {
        errorVisible.value = true
        ElMessage.error(`${i18n.global.t('updater.downloadFailed')}: ${error.value}`)
      }
      return result
    }
    if (disposed || !canDownload.value || !pending) return false
    const update = pending
    const token = generation
    phase.value = 'downloading'
    error.value = ''
    errorVisible.value = false
    progress.value = 0
    downloading = (async () => {
      try {
        let bytes = 0
        let total = 0
        await update.download(event => {
          if (disposed || token !== generation) return
          if (event.event === 'Started') { total = event.data.contentLength ?? 0; bytes = 0; progress.value = total > 0 ? 0 : null }
          if (event.event === 'Progress') { bytes += event.data.chunkLength; progress.value = total > 0 ? Math.min(100, Math.round(bytes / total * 100)) : null }
        }, { timeout: 300000 })
        if (disposed || token !== generation) return false
        downloaded = true
        progress.value = 100
        phase.value = 'ready'
        return true
      } catch (cause) {
        if (!disposed && token === generation) { phase.value = 'available'; fail(cause, interactive, 'updater.downloadFailed') }
        return false
      }
    })().finally(() => { downloading = undefined })
    return downloading
  }
  function initialize() {
    if (initialized || disposed) return
    initialized = true
    timer = setTimeout(() => { void check() }, 8000)
  }
  function impacts() {
    const mqtt = [...useMqttStore().connectionStates].flatMap(([id, state]) =>
      ['connected', 'connecting', 'reconnecting'].includes(state.status)
        ? [{ id, kind: 'mqtt', token: state.status }] : [])
    return [...mqtt, ...getUpdateImpacts()]
  }
  type Impacts = ReturnType<typeof impacts>
  const sameImpacts = (a: Impacts, b: Impacts) => a.length === b.length && a.every((item, index) =>
    item.id === b[index].id && item.token === b[index].token)
  async function confirmInstall(snapshot: Impacts) {
    const t = i18n.global.t
    const cancelled = new Promise<boolean>(resolve => {
      cancelConfirmation = () => { resolve(false); ElMessageBox.close() }
    })
    try {
      const confirmation = ElMessageBox.confirm(h('div', [
        h('p', t('updater.confirm', { version: info.value?.latestVersion })),
        h('ul', [...new Set(snapshot.map(item => item.kind))].map(kind => h('li', t(`updater.impacts.${kind}`)))),
        h('button', { type: 'button', class: 'el-button', onClick: () => { defer(); cancelConfirmation?.() } }, t('updater.later')),
      ]), t('updater.restart'), {
        confirmButtonText: t('updater.restart'), cancelButtonText: t('common.cancel'),
        closeOnClickModal: false, type: snapshot.length ? 'warning' : 'info',
      }).then(() => true, () => false)
      // Element Plus close() removes the box without settling its promise.
      return await Promise.race([confirmation, cancelled])
    } catch { return false } finally { cancelConfirmation = undefined }
  }
  async function install() {
    if (installing) return installing
    if (disposed || !pending || !canInstall.value) return false
    const update = pending
    const token = generation
    phase.value = 'installing'
    error.value = ''
    const valid = () => !disposed && token === generation && pending === update
    installing = (async () => {
      try {
        let approved: Impacts | undefined
        // Every await may allow a new activity or a new draft revision. Repeat
        // consent and flush until the current snapshot is exactly the approved one.
        async function protectAndFlush() {
          while (valid()) {
            const current = impacts()
            if (!approved || !sameImpacts(approved, current)) {
              if (!await confirmInstall(current)) return false
              approved = current
              if (!valid() || !sameImpacts(approved, impacts())) continue
            }
            await errorLogBuffer.flush()
            if (valid() && sameImpacts(approved, impacts())) return true
          }
          return false
        }
        async function runProtected(step: () => Promise<void>) {
          while (valid()) {
            if (!await protectAndFlush()) return false
            // Returning from an async helper is another yield. Validate again
            // and invoke the native operation in this same synchronous turn.
            if (!valid()) return false
            if (!approved || !sameImpacts(approved, impacts())) continue
            await step()
            return true
          }
          return false
        }
        if (!installed) {
          if (!await runProtected(async () => { await update.install(); installed = true })) return false
        }
        if (!await runProtected(relaunch)) return false
        return true
      } catch (cause) {
        if (valid()) fail(cause, true, 'errors.updateInstallFailed')
        throw cause
      } finally {
        if (valid()) phase.value = 'ready'
      }
    })().finally(() => { installing = undefined })
    return installing
  }
  function defer() { deferred.value = true }
  async function skipVersion() {
    if (disposed || phase.value === 'installing' || !pending) return
    skippedVersion.value = pending.version
    localStorage.setItem('mqtt-client-update-skipped-version', pending.version)
    generation++
    const update = pending
    pending = null
    downloaded = false
    info.value = null
    progress.value = null
    error.value = ''
    phase.value = 'idle'
    await Promise.allSettled([checking, downloading].filter(Boolean))
    await close(update)
  }
  function dispose() {
    if (disposing) return disposing
    disposed = true
    generation++
    clearTimeout(timer)
    cancelConfirmation?.()
    pending = null
    info.value = null
    progress.value = null
    error.value = ''
    errorVisible.value = false
    phase.value = 'idle'
    disposing = (async () => {
      await Promise.allSettled([checking, downloading, installing].filter(Boolean))
      await Promise.all([...resources].map(close))
    })().finally(() => { disposing = undefined })
    return disposing
  }
  return { phase, info, progress, error, errorVisible, deferred, autoCheck, autoDownload, skippedVersion, lastCheckedAt, canDownload, canInstall, initialize, check, download, install, defer, skipVersion, setPreferences, dispose }
})
