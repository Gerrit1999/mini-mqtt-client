<template>
  <el-dialog
    v-model="dialogVisible"
    :title="$t('settings.title')"
    width="640px"
    :close-on-click-modal="false"
    class="settings-dialog"
    @open="loadSettings"
  >
    <div class="settings-content">
      <!-- 主题设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.theme.title') }}</div>
          <div class="setting-desc">{{ $t('settings.theme.desc') }}</div>
        </div>
        <el-radio-group
          v-model="currentTheme"
          @change="(val: string | number | boolean | undefined) => handleThemeChange(val as Theme)"
          class="theme-radio-group"
        >
          <el-radio-button value="light">
            <el-icon><Sunny /></el-icon>
            {{ $t('settings.theme.light') }}
          </el-radio-button>
          <el-radio-button value="dark">
            <el-icon><Moon /></el-icon>
            {{ $t('settings.theme.dark') }}
          </el-radio-button>
          <el-radio-button value="auto">
            <el-icon><Platform /></el-icon>
            {{ $t('settings.theme.auto') }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 语言设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.language.title') }}</div>
          <div class="setting-desc">{{ $t('settings.language.desc') }}</div>
        </div>
        <el-radio-group
          v-model="currentLocale"
          @change="(val: string | number | boolean | undefined) => handleLocaleChange(val as Locale)"
          class="theme-radio-group"
        >
          <el-radio-button value="zh-CN">
            {{ $t('settings.language.zhCN') }}
          </el-radio-button>
          <el-radio-button value="en-US">
            {{ $t('settings.language.enUS') }}
          </el-radio-button>
          <el-radio-button value="auto">
            <el-icon><Platform /></el-icon>
            {{ $t('settings.language.auto') }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 消息设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.messages.title') }}</div>
          <div class="setting-desc">{{ $t('settings.messages.desc') }}</div>
        </div>
        <div class="setting-row message-setting-row">
          <span class="setting-label setting-label--compact">{{ $t('settings.messages.limit') }}</span>
          <el-input-number
            v-model="currentMessageLimit"
            :min="MESSAGE_LIMIT_MIN"
            :max="MESSAGE_LIMIT_MAX"
            :step="100"
            :controls-position="'right'"
            size="small"
            class="limit-input"
          />
        </div>
        <div class="setting-row message-setting-row">
          <span class="setting-label setting-label--compact">{{ $t('settings.messages.retentionDays') }}</span>
          <el-input-number
            v-model="currentMessageRetentionDays"
            :min="MESSAGE_RETENTION_DAYS_MIN"
            :max="MESSAGE_RETENTION_DAYS_MAX"
            :step="1"
            :controls-position="'right'"
            size="small"
            class="limit-input"
          />
          <span class="setting-unit">{{ $t('settings.messages.daysUnit') }}</span>
        </div>
        <div class="setting-row message-setting-row">
          <span class="setting-label setting-label--compact">{{ $t('settings.messages.retentionCount') }}</span>
          <el-input-number
            v-model="currentMessageRetentionCount"
            :min="MESSAGE_RETENTION_COUNT_MIN"
            :max="MESSAGE_RETENTION_COUNT_MAX"
            :step="1000"
            :controls-position="'right'"
            size="small"
            class="limit-input"
          />
        </div>
        <div class="setting-row message-setting-row">
          <span class="setting-label setting-label--compact">{{ $t('settings.messages.storageMaintenance') }}</span>
          <el-button
            size="small"
            :icon="Refresh"
            :loading="cleaningMessages"
            @click="handleCleanupMessages"
          >
            {{ $t('settings.messages.cleanupAndVacuum') }}
          </el-button>
        </div>
      </div>

      <!-- MQTT 设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.mqtt.title') }}</div>
          <div class="setting-desc">{{ $t('settings.mqtt.desc') }}</div>
        </div>
        <div class="setting-row message-setting-row">
          <span class="setting-label setting-label--compact">{{ $t('settings.mqtt.packetSizeLimit') }}</span>
          <el-input-number
            v-model="currentMqttPacketSizeLimitKb"
            :min="MQTT_PACKET_SIZE_LIMIT_MIN"
            :max="MQTT_PACKET_SIZE_LIMIT_MAX"
            :step="256"
            :controls-position="'right'"
            size="small"
            class="limit-input"
          />
          <span class="setting-unit">KB</span>
        </div>
      </div>

      <!-- 数据存储设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.storage.title') }}</div>
          <div class="setting-desc">{{ $t('settings.storage.desc') }}</div>
        </div>
        <div class="path-group">
          <el-input :model-value="currentDataPath" readonly size="small" class="path-input" />
          <div class="action-group">
            <el-tooltip :content="$t('settings.storage.changeLocation')" placement="top">
              <el-button size="small" :icon="FolderOpened" @click="handleSelectFolder" />
            </el-tooltip>
            <el-tooltip :content="$t('settings.storage.copyPath')" placement="top">
              <el-button size="small" :icon="CopyDocument" @click="handleCopyPath" />
            </el-tooltip>
          </div>
        </div>
        <el-alert
          v-if="newDataPath"
          type="warning"
          :closable="false"
          show-icon
          class="migrate-alert"
        >
          <template #title>
            <span>{{ $t('settings.storage.migrateAlert') }}: {{ truncatePath(newDataPath) }}</span>
          </template>
        </el-alert>
      </div>

      <!-- 日志设置 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.log.title') }}</div>
          <div class="setting-desc">{{ $t('settings.log.desc') }}</div>
        </div>
        <div class="path-group">
          <el-input :model-value="logPath" readonly size="small" class="path-input" />
          <div class="action-group">
            <el-tooltip :content="$t('settings.log.openDir')" placement="top">
              <el-button size="small" :icon="FolderOpened" @click="handleOpenLogFolder" />
            </el-tooltip>
            <el-tooltip :content="$t('settings.log.clear')" placement="top">
              <el-button size="small" :icon="Delete" type="danger" plain @click="handleClearLogs" />
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- 检查更新 -->
      <div class="setting-section">
        <div class="setting-header">
          <div class="setting-title">{{ $t('settings.update.title') }}</div>
          <div class="setting-desc">{{ $t('settings.update.currentVersion') }}: v{{ currentVersion }}</div>
        </div>
        <div class="update-row">
          <el-button
            size="small"
            :icon="Refresh"
            :loading="checkingUpdate"
            @click="handleCheckUpdate"
          >
            {{ $t('settings.update.check') }}
          </el-button>
          <div v-if="updateInfo" class="update-status">
            <el-tag v-if="updateInfo.hasUpdate" type="success" effect="plain">
              {{ $t('settings.update.newVersion') }}: {{ updateInfo.latestVersion }}
            </el-tag>
            <el-tag v-else type="info" effect="plain">
              {{ $t('settings.update.upToDate') }}
            </el-tag>
            <el-button 
              v-if="updateInfo.hasUpdate"
              size="small" 
              type="primary"
              :icon="Download"
              @click="handleOpenRelease"
            >
              {{ $t('settings.update.download') }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleClose">{{ $t('common.cancel') }}</el-button>
      <el-button 
        type="primary" 
        :loading="saving"
        :disabled="!hasChanges"
        @click="handleSave"
      >
        {{ $t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Sunny, Moon, Platform, FolderOpened, CopyDocument, Delete, Refresh, Download } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import { getVersion } from '@tauri-apps/api/app'
import { useAppStore, type Theme, type Locale } from '@/stores/app'
import { useMqttStore } from '@/stores/mqtt'
import { useMessageStore } from '@/stores/message'

const GITHUB_REPO = 'Gerrit1999/mini-mqtt-client'
const MESSAGE_LIMIT_MIN = 100
const MESSAGE_LIMIT_MAX = 10000
const MQTT_PACKET_SIZE_LIMIT_MIN = 10
const MQTT_PACKET_SIZE_LIMIT_MAX = 102400
const MESSAGE_RETENTION_DAYS_MIN = 1
const MESSAGE_RETENTION_DAYS_MAX = 3650
const MESSAGE_RETENTION_COUNT_MIN = 1000
const MESSAGE_RETENTION_COUNT_MAX = 10000000

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const appStore = useAppStore()
const mqttStore = useMqttStore()
const messageStore = useMessageStore()
const { t } = useI18n()

const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
})

// 状态
const saving = ref(false)
const currentTheme = ref<Theme>('light')
const originalTheme = ref<Theme>('light')
const currentLocale = ref<Locale>('auto')
const originalLocale = ref<Locale>('auto')
const currentMessageLimit = ref(1000)
const originalMessageLimit = ref(1000)
const currentMqttPacketSizeLimitKb = ref(1024)
const originalMqttPacketSizeLimitKb = ref(1024)
const currentMessageRetentionDays = ref(30)
const originalMessageRetentionDays = ref(30)
const currentMessageRetentionCount = ref(100000)
const originalMessageRetentionCount = ref(100000)
const currentDataPath = ref('')
const newDataPath = ref('')
const logPath = ref('')
const currentVersion = ref('')
const checkingUpdate = ref(false)
const cleaningMessages = ref(false)
const updateInfo = ref<{ hasUpdate: boolean; latestVersion: string } | null>(null)

// 是否有更改
const hasChanges = computed(() => {
  return currentTheme.value !== originalTheme.value || 
         currentLocale.value !== originalLocale.value ||
         currentMessageLimit.value !== originalMessageLimit.value ||
         currentMqttPacketSizeLimitKb.value !== originalMqttPacketSizeLimitKb.value ||
         currentMessageRetentionDays.value !== originalMessageRetentionDays.value ||
         currentMessageRetentionCount.value !== originalMessageRetentionCount.value ||
         newDataPath.value !== ''
})

// 加载设置
async function loadSettings() {
  currentTheme.value = appStore.theme
  originalTheme.value = appStore.theme
  currentLocale.value = appStore.locale
  originalLocale.value = appStore.locale
  currentMessageLimit.value = appStore.messageLimit
  originalMessageLimit.value = appStore.messageLimit
  currentMqttPacketSizeLimitKb.value = appStore.mqttPacketSizeLimitKb
  originalMqttPacketSizeLimitKb.value = appStore.mqttPacketSizeLimitKb
  currentMessageRetentionDays.value = appStore.messageRetentionDays
  originalMessageRetentionDays.value = appStore.messageRetentionDays
  currentMessageRetentionCount.value = appStore.messageRetentionCount
  originalMessageRetentionCount.value = appStore.messageRetentionCount
  newDataPath.value = ''
  updateInfo.value = null
  
  try {
    currentVersion.value = await getVersion()
  } catch (e) {
    currentVersion.value = '1.0.0'
  }
  
  try {
    currentDataPath.value = await invoke<string>('get_data_path')
  } catch (e) {
    console.error('获取数据路径失败:', e)
  }

  try {
    const settings = await invoke<{
      message_limit: number;
      mqtt_packet_size_limit_kb: number;
      message_retention_days: number;
      message_retention_count: number;
    }>('get_app_settings')
    currentMessageLimit.value = settings.message_limit
    originalMessageLimit.value = settings.message_limit
    currentMqttPacketSizeLimitKb.value = settings.mqtt_packet_size_limit_kb
    originalMqttPacketSizeLimitKb.value = settings.mqtt_packet_size_limit_kb
    currentMessageRetentionDays.value = settings.message_retention_days
    originalMessageRetentionDays.value = settings.message_retention_days
    currentMessageRetentionCount.value = settings.message_retention_count
    originalMessageRetentionCount.value = settings.message_retention_count
    appStore.setMessageLimit(settings.message_limit)
    appStore.setMqttPacketSizeLimitKb(settings.mqtt_packet_size_limit_kb)
    appStore.setMessageCleanupPolicy(settings.message_retention_days, settings.message_retention_count)
  } catch (e) {
    console.error('获取应用设置失败:', e)
  }
  
  try {
    logPath.value = await invoke<string>('get_log_dir')
  } catch (e) {
    console.error('获取日志路径失败:', e)
  }
}

// 主题变化
function handleThemeChange(theme: Theme) {
  appStore.setTheme(theme)
}

// 语言变化
function handleLocaleChange(locale: Locale) {
  appStore.setLocale(locale)
}

// 选择文件夹
async function handleSelectFolder() {
  try {
    const path = await invoke<string | null>('select_data_folder')
    if (path) {
      newDataPath.value = path
    }
  } catch (e) {
    ElMessage.error(`${t('errors.selectFolderFailed')}: ${e}`)
  }
}

// 复制路径
async function handleCopyPath() {
  try {
    await navigator.clipboard.writeText(currentDataPath.value)
    ElMessage.success(t('success.copied'))
  } catch (e) {
    ElMessage.error(t('errors.copyFailed'))
  }
}

// 打开日志文件夹
async function handleOpenLogFolder() {
  try {
    await revealItemInDir(logPath.value)
  } catch (e) {
    ElMessage.error(`${t('errors.openFolderFailed')}: ${e}`)
  }
}

// 清空日志
async function handleClearLogs() {
  try {
    await ElMessageBox.confirm(
      t('settings.log.clearConfirm'),
      t('settings.log.clearTitle'),
      {
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      }
    )
    
    await invoke('clear_logs')
    ElMessage.success(t('settings.log.clearSuccess'))
  } catch (e: any) {
    if (e !== 'cancel') {
      ElMessage.error(`${t('errors.deleteFailed')}: ${e}`)
    }
  }
}

async function handleCleanupMessages() {
  cleaningMessages.value = true
  try {
    const result = await invoke<{
      deleted_by_age: number;
      deleted_by_count: number;
      vacuumed: boolean;
    }>('cleanup_message_history', { vacuum: true })
    ElMessage.success(
      t('settings.messages.cleanupSuccess', {
        count: result.deleted_by_age + result.deleted_by_count,
      })
    )
  } catch (e) {
    ElMessage.error(`${t('errors.deleteFailed')}: ${e}`)
  } finally {
    cleaningMessages.value = false
  }
}

// 截断路径显示
function truncatePath(path: string): string {
  if (!path) return ''
  const maxLen = 40
  if (path.length <= maxLen) return path
  
  // 显示开头和结尾
  const start = path.substring(0, 15)
  const end = path.substring(path.length - 20)
  return `${start}...${end}`
}

// 保存设置
async function handleSave() {
  saving.value = true
  
  try {
    // 如果有新的数据路径
    if (newDataPath.value) {
      const action = await ElMessageBox.confirm(
        t('settings.storage.migrateConfirm'),
        t('settings.storage.migrateTitle'),
        {
          confirmButtonText: t('settings.storage.migrateBtn'),
          cancelButtonText: t('settings.storage.changeOnlyBtn'),
          distinguishCancelAndClose: true,
          type: 'info',
        }
      ).then(() => 'migrate').catch((action: string) => action)
      
      if (action === 'close') {
        saving.value = false
        return
      }
      
      const shouldMigrate = action === 'migrate'
      await invoke('migrate_data_path', { newPath: newDataPath.value, migrate: shouldMigrate })
      
      if (shouldMigrate) {
        ElMessage.success(t('settings.storage.migrateSuccess'))
      } else {
        ElMessage.success(t('settings.storage.changeSuccess'))
      }
    }

    if (currentMessageLimit.value !== originalMessageLimit.value) {
      const settings = await invoke<{ message_limit: number }>('update_message_limit', {
        messageLimit: currentMessageLimit.value,
      })
      appStore.setMessageLimit(settings.message_limit)
      mqttStore.applyMessageLimit()
      messageStore.applyMessageLimit()
      originalMessageLimit.value = settings.message_limit
    }

    if (currentMqttPacketSizeLimitKb.value !== originalMqttPacketSizeLimitKb.value) {
      const settings = await invoke<{ message_limit: number; mqtt_packet_size_limit_kb: number }>(
        'update_mqtt_packet_size_limit',
        {
          mqttPacketSizeLimitKb: currentMqttPacketSizeLimitKb.value,
        }
      )
      appStore.setMqttPacketSizeLimitKb(settings.mqtt_packet_size_limit_kb)
      originalMqttPacketSizeLimitKb.value = settings.mqtt_packet_size_limit_kb
    }

    if (
      currentMessageRetentionDays.value !== originalMessageRetentionDays.value ||
      currentMessageRetentionCount.value !== originalMessageRetentionCount.value
    ) {
      const settings = await invoke<{
        message_retention_days: number;
        message_retention_count: number;
      }>('update_message_cleanup_policy', {
        messageRetentionDays: currentMessageRetentionDays.value,
        messageRetentionCount: currentMessageRetentionCount.value,
      })
      appStore.setMessageCleanupPolicy(
        settings.message_retention_days,
        settings.message_retention_count
      )
      originalMessageRetentionDays.value = settings.message_retention_days
      originalMessageRetentionCount.value = settings.message_retention_count
      await invoke('cleanup_message_history', { vacuum: false })
    }
    
    dialogVisible.value = false
  } catch (e: any) {
    if (e !== 'cancel') {
      ElMessage.error(`${t('errors.saveFailed')}: ${e}`)
    }
  } finally {
    saving.value = false
  }
}

// 关闭对话框
function handleClose() {
  // 如果主题已更改但未保存，恢复原始主题
  if (currentTheme.value !== originalTheme.value && !saving.value) {
    appStore.setTheme(originalTheme.value)
  }
  // 如果语言已更改但未保存，恢复原始语言
  if (currentLocale.value !== originalLocale.value && !saving.value) {
    appStore.setLocale(originalLocale.value)
  }
  dialogVisible.value = false
}

// 检查更新
async function handleCheckUpdate() {
  checkingUpdate.value = true
  updateInfo.value = null
  
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
    if (!response.ok) {
      throw new Error('获取版本信息失败')
    }
    
    const data = await response.json()
    const latestVersion = data.tag_name?.replace(/^v/, '') || ''
    const hasUpdate = compareVersions(latestVersion, currentVersion.value) > 0
    
    updateInfo.value = { hasUpdate, latestVersion: `v${latestVersion}` }
    
    if (!hasUpdate) {
      ElMessage.success(t('settings.update.upToDate'))
    }
  } catch (e) {
    ElMessage.error(`${t('errors.checkUpdateFailed')}: ${e}`)
  } finally {
    checkingUpdate.value = false
  }
}

// 比较版本号
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

// 打开 release 页面
async function handleOpenRelease() {
  try {
    await openUrl(`https://github.com/${GITHUB_REPO}/releases/latest`)
  } catch (e) {
    ElMessage.error(`${t('errors.openBrowserFailed')}: ${e}`)
  }
}
</script>

<style scoped lang="scss">
:global(.settings-dialog) {
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 48px auto;
}

:global(.settings-dialog .el-dialog__body) {
  padding-top: 12px;
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  min-height: 0;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.setting-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--app-border-color);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.setting-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text-color);
}

.setting-desc {
  font-size: 12px;
  color: var(--app-text-secondary);
  line-height: 1.4;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.setting-label {
  min-width: 110px;
  font-size: 12px;
  color: var(--app-text-secondary);
}

.setting-label--compact {
  min-width: auto;
}

.message-setting-row {
  gap: 14px;
}

.limit-input {
  width: 180px;
}

.setting-unit {
  font-size: 12px;
  color: var(--app-text-secondary);
}

.path-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.path-input {
  flex: 1;
  min-width: 0;
  
  :deep(input) {
    font-family: 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
  }
}

.action-group {
  display: flex;
  align-items: center;
  gap: 0px;
  flex-shrink: 0;
}

.migrate-alert {
  margin-top: 4px;
}

.update-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.update-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.theme-radio-group {
  width: 100%;

  :deep(.el-radio-button__inner) {
    display: flex;
    align-items: center;
    gap: 4px;
  }
}

:deep(.el-radio-group) {
  overflow: hidden;
}

:deep(.el-dialog__footer .el-button + .el-button) {
  margin-left: 5px;
}
</style>
