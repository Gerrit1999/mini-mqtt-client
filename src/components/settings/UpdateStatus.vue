<template>
  <section
    v-if="updater.info?.hasUpdate || (updater.error && updater.errorVisible)"
    class="update-status-card"
    :class="{ floating: !embedded, collapsed: updater.deferred && !embedded }"
    aria-live="polite"
  >
    <ElButton v-if="updater.deferred && !embedded" data-action="show" @click="updater.deferred = false">
      {{ $t('updater.title') }} {{ updater.info?.latestVersion }} · {{ $t(`updater.phases.${updater.phase}`) }}
    </ElButton>
    <template v-else>
      <div class="update-heading">
        <strong>{{ $t('updater.title') }}</strong>
        <span>{{ updater.info?.latestVersion }}</span>
      </div>
      <p class="update-detail">{{ $t(`updater.phases.${updater.phase}`) }}</p>
      <div v-if="updater.phase === 'downloading'" class="update-progress">
        <progress :value="updater.progress ?? undefined" max="100" :aria-label="$t('updater.phases.downloading')" />
        <span v-if="updater.progress !== null">{{ updater.progress }}%</span>
      </div>
      <p v-if="updater.info?.date" class="update-detail">{{ $t('updater.releaseDate') }}: {{ updater.info.date }}</p>
      <p v-if="updater.error && updater.errorVisible" class="update-error" role="alert">
        {{ $t('updater.failure') }}: {{ updater.error }}
      </p>
      <UpdateReleaseNotes v-if="updater.info?.body?.trim()" :body="updater.info.body" />
      <div v-if="updater.phase !== 'installing'" class="update-actions">
        <ElButton v-if="updater.info?.hasUpdate" size="small" text data-action="skip" @click="skip">
          {{ $t('updater.skip') }}
        </ElButton>
        <ElButton size="small" data-action="later" @click="updater.defer()">{{ $t('updater.later') }}</ElButton>
        <ElButton v-if="updater.canDownload" size="small" type="primary" data-action="download" @click="updater.download()">
          {{ $t('updater.download') }}
        </ElButton>
        <ElButton v-if="updater.phase === 'ready'" size="small" type="primary" data-action="restart" @click="install">
          {{ $t('updater.restart') }}
        </ElButton>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ElButton } from 'element-plus'
import UpdateReleaseNotes from './UpdateReleaseNotes.vue'
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
.update-status-card {
  padding: 14px 16px;
  border: 1px solid var(--app-border-color);
  border-radius: 10px;
  background: var(--card-bg);
  color: var(--app-text-color);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.floating {
  position: fixed;
  right: 16px;
  bottom: 52px;
  z-index: 1900;
  width: min(360px, calc(100vw - 32px));
  max-height: 60vh;
  overflow: auto;
  box-shadow: var(--el-box-shadow-light);
}

.collapsed {
  width: auto;
  max-width: calc(100vw - 32px);
  padding: 0;
  border: 0;
  border-radius: var(--app-control-radius);
}

.collapsed :deep(.el-button) {
  max-width: 100%;
  height: auto;
  padding-block: 6px;
  white-space: normal;
}

.update-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.update-heading strong {
  font-size: 14px;
  font-weight: 600;
}

.update-heading span,
.update-detail,
.update-progress {
  color: var(--app-text-secondary);
}

.update-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block: 4px;
}

progress {
  flex: 1;
  min-width: 0;
  height: 6px;
  accent-color: var(--primary-color);
}

.update-error {
  margin-top: 6px;
  color: var(--el-color-danger);
}

.update-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}

.update-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
