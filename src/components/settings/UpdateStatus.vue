<template>
  <section v-if="updater.info?.hasUpdate || (updater.error && updater.errorVisible)" class="update-status-card" :class="{ floating: !embedded }" aria-live="polite">
    <button v-if="updater.deferred && !embedded" data-action="show" @click="updater.deferred = false">
      {{ $t('updater.title') }} {{ updater.info?.latestVersion }} · {{ $t(`updater.phases.${updater.phase}`) }}
    </button>
    <template v-else>
      <strong>{{ $t('updater.title') }} {{ updater.info?.latestVersion }}</strong>
      <p v-if="updater.info?.date">{{ $t('updater.releaseDate') }}: {{ updater.info.date }}</p>
      <p>{{ $t(`updater.phases.${updater.phase}`) }}</p>
      <progress v-if="updater.phase === 'downloading'" :value="updater.progress ?? undefined" max="100" :aria-label="$t('updater.phases.downloading')" />
      <span v-if="updater.phase === 'downloading' && updater.progress !== null"> {{ updater.progress }}%</span>
      <p v-if="updater.error && updater.errorVisible" role="alert">{{ $t('updater.failure') }}: {{ updater.error }}</p>
      <details v-if="updater.info?.body">
        <summary>{{ $t('updater.releaseNotes') }}</summary>
        <pre>{{ updater.info.body }}</pre>
      </details>
      <div class="update-actions">
        <button v-if="updater.canDownload" data-action="download" @click="updater.download()">{{ $t('updater.download') }}</button>
        <button v-if="updater.phase === 'ready'" data-action="restart" @click="install">{{ $t('updater.restart') }}</button>
        <button v-if="updater.phase !== 'installing'" data-action="later" @click="updater.defer()">{{ $t('updater.later') }}</button>
        <button v-if="updater.info?.hasUpdate && updater.phase !== 'installing'" data-action="skip" @click="skip">{{ $t('updater.skip') }}</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { useUpdaterStore } from '@/stores/updater'
defineProps<{ embedded?: boolean }>()
const updater = useUpdaterStore()
async function install() {
  try { await updater.install() } catch { /* The updater reports interactive failures. */ }
}
async function skip() {
  try { await updater.skipVersion() } catch (error) { console.error('Updater cleanup:', error) }
}
</script>

<style scoped>
.update-status-card { padding: 12px; border: 1px solid var(--app-border-color); border-radius: 8px; background: var(--app-bg-color); color: var(--app-text-color); }
.floating { position: fixed; right: 18px; bottom: 18px; z-index: 1900; width: min(380px, calc(100vw - 36px)); max-height: 45vh; overflow: auto; box-shadow: 0 4px 20px #0003; }
p, details { margin: 6px 0; font-size: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 160px; overflow: auto; }
.update-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
button { cursor: pointer; padding: 5px 8px; border-radius: 4px; border: 1px solid var(--app-border-color); background: var(--app-bg-color); color: var(--app-text-color); }
button:hover { color: var(--el-color-primary); border-color: var(--el-color-primary); }
summary { cursor: pointer; }
</style>
