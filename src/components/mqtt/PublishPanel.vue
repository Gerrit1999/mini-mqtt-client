<template>
  <div class="publish-panel-wrapper">
    <div
      class="publish-panel app-card"
      :class="[
        `is-${props.layout}`,
        { 'is-collapsed': props.collapsed },
      ]"
    >
      <div class="panel-header">
        <span class="panel-title">
          <el-icon><Promotion /></el-icon>
          <span class="panel-title-label">{{ $t('publish.title') }}</span>
        </span>
        <div class="panel-header-actions">
          <div v-if="!props.collapsed" class="header-actions">
            <div class="publish-option format-option">
              <el-select v-model="payloadFormat">
                <el-option
                  v-for="opt in formatOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
            <div class="publish-option qos-option">
              <el-select v-model="publishData.qos">
                <el-option :value="0" label="QoS 0" />
                <el-option :value="1" label="QoS 1" />
                <el-option :value="2" label="QoS 2" />
              </el-select>
            </div>
            <div class="retain-option">
              <el-checkbox v-model="publishData.retain">Retain</el-checkbox>
            </div>
          </div>
          <el-tooltip
            :content="props.collapsed ? $t('publish.expandPanel') : $t('publish.collapsePanel')"
            placement="top"
          >
            <el-button
              text
              class="collapse-button"
              :icon="collapseIcon"
              :aria-label="props.collapsed ? $t('publish.expandPanel') : $t('publish.collapsePanel')"
              :aria-expanded="!props.collapsed"
              @click="emit('toggleCollapse')"
            />
          </el-tooltip>
        </div>
      </div>

      <div v-if="!props.collapsed" class="publish-form">
        <div class="topic-row">
          <div class="topic-input">
            <el-input
              v-model="publishData.topic"
              :placeholder="$t('publish.topicPlaceholder')"
              size="default"
            >
              <template #prefix>
                <span class="topic-prefix">Topic</span>
              </template>
            </el-input>
          </div>

          <el-button
            class="btn-timed-message"
            :icon="props.timedMessageRunning ? Loading : Timer"
            :type="props.timedMessageRunning ? 'danger' : 'default'"
            :class="{ 'is-running': props.timedMessageRunning }"
            @click="handleTimedMessage"
          >
            {{ props.timedMessageRunning ? $t('timedMessage.stop') : $t('publish.timedMessage') }}
          </el-button>

          <el-button
            class="btn-scheduled-publish"
            :icon="props.scheduledPublishRunning ? Loading : Timer"
            :type="props.scheduledPublishRunning ? 'primary' : 'default'"
            :class="{ 'is-running': props.scheduledPublishRunning }"
            @click="handleScheduledPublish"
          >
            {{ props.scheduledPublishRunning ? $t('scheduled.running') : $t('publish.scheduledPublish') }}
          </el-button>
        </div>

        <div
          class="payload-input-wrapper"
          :class="{ 'has-format-action': payloadFormat === 'json' }"
        >
          <el-input
            v-model="publishData.payload"
            type="textarea"
            :placeholder="payloadPlaceholder"
            resize="none"
            class="payload-input"
          />
          <el-tooltip
            v-if="payloadFormat === 'json'"
            :content="$t('publish.formatJson')"
            placement="top"
          >
            <el-button
              text
              class="payload-format-button"
              :icon="MagicStick"
              :aria-label="$t('publish.formatJson')"
              @click="formatJsonPayload"
            />
          </el-tooltip>
        </div>

        <div class="action-row-bottom">
          <el-tooltip :content="$t('publish.openTemplates')" placement="top">
            <el-button
              class="icon-action"
              :icon="FolderOpened"
              :aria-label="$t('publish.openTemplates')"
              @click="handleOpenTemplates"
            />
          </el-tooltip>
          <el-tooltip :content="$t('publish.saveTemplate')" placement="top">
            <el-button
              class="icon-action"
              :icon="Star"
              :aria-label="$t('publish.saveTemplate')"
              @click="handleSaveTemplate"
            />
          </el-tooltip>
          <el-button
            class="send-button"
            type="primary"
            :icon="Promotion"
            :loading="publishing"
            :disabled="!isConnected"
            @click="handlePublish"
          >
            {{ $t('publish.send') }}
          </el-button>
        </div>
      </div>
    </div>

    <!-- 定时消息配置对话框 -->
    <el-dialog
      v-model="timedMessageDialogVisible"
      :title="$t('timedMessage.title')"
      width="400px"
      :close-on-click-modal="false"
      :append-to-body="false"
    >
    <el-form label-width="100px">
      <el-form-item :label="$t('timedMessage.frequency')">
        <el-input-number
          v-model="timedMessageInterval"
          :min="0.1"
          :max="3600"
          :step="0.1"
          :precision="1"
          style="width: 140px"
        />
        <span class="unit">{{ $t('timedMessage.frequencyUnit') }}</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="timedMessageDialogVisible = false">{{ $t('common.cancel') }}</el-button>
      <el-button type="primary" @click="startTimedMessage">{{ $t('timedMessage.start') }}</el-button>
    </template>
  </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Promotion,
  Star,
  FolderOpened,
  Timer,
  Loading,
  MagicStick,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "@/stores/server";
import { useMqttStore } from "@/stores/mqtt";
import { useAppStore } from "@/stores/app";
import { useEnvStore } from "@/stores/env";
import { ScriptEngine } from "@/utils/scriptEngine";
import type { Script } from "@/stores/script";
import { validatePublishTopic, handleMqttError } from "@/utils/mqttErrorHandler";
import { handleScriptError } from "@/utils/errorHandler";
import { decodePayload } from "@/utils/payloadCodec";
import type { PayloadFormat } from "@/types/mqtt";
import type { ContentLayout } from "@/stores/app";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  collapsed: boolean;
  layout?: ContentLayout;
  scheduledPublishRunning: boolean;
  timedMessageRunning: boolean;
}>(), {
  layout: "horizontal",
});

const collapseIcon = computed(() => {
  if (props.layout === "horizontal") {
    return props.collapsed ? ArrowLeft : ArrowRight;
  }
  return props.collapsed ? ArrowUp : ArrowDown;
});

const formatOptions = [
  { label: "JSON", value: "json" },
  { label: "HEX", value: "hex" },
  { label: "Base64", value: "base64" },
  { label: "Text", value: "text" },
] satisfies Array<{ label: string; value: PayloadFormat }>;

const serverStore = useServerStore();
const mqttStore = useMqttStore();
const appStore = useAppStore();
const envStore = useEnvStore();

const publishing = ref(false);

// ===== 定时消息状态 =====
const timedMessageDialogVisible = ref(false);
const timedMessageInterval = ref(1);
const timedMessageCount = ref(0);
let timedMessageTimer: ReturnType<typeof setTimeout> | null = null;
let timedMessageActive = false;

const emit = defineEmits<{
  saveTemplate: [data: { topic: string; payload: string; qos: number; retain: boolean; payloadType: PayloadFormat }]
  openTemplates: []
  scheduledPublish: []
  toggleCollapse: []
  'update:timedMessageRunning': [value: boolean]
}>();

// 监听复制到发布的消息
watch(
  () => appStore.copyToPublishData,
  (data) => {
    if (data) {
      publishData.topic = data.topic;
      publishData.payload = data.payload;
      publishData.qos = data.qos;
      publishData.retain = data.retain;

      // 设置格式类型
      if (data.payloadType) {
        payloadFormat.value = data.payloadType;
      } else if (data.payload.trim()) {
        // 自动检测格式
        try {
          JSON.parse(data.payload.trim());
          payloadFormat.value = "json";
        } catch {
          payloadFormat.value = "text";
        }
      }

      // 清除复制数据
      appStore.clearCopyToPublish();
    }
  }
);

const publishData = reactive({
  topic: "",
  payload: "",
  qos: 0,
  retain: false,
});

const payloadFormat = ref<PayloadFormat>("json");

const isConnected = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return false;
  return mqttStore.getConnectionStatus(serverId) === "connected";
});

// 监听连接状态变化，断开时自动停止定时消息
watch(
  isConnected,
  (connected) => {
    if (!connected && props.timedMessageRunning) {
      stopTimedMessage();
    }
  }
);

const payloadPlaceholder = computed(() => {
  return t('publish.payloadPlaceholder');
});

function formatJsonPayload() {
  if (!publishData.payload.trim()) return;

  try {
    publishData.payload = JSON.stringify(JSON.parse(publishData.payload), null, 2);
  } catch {
    ElMessage.warning(t("errors.jsonInvalid"));
  }
}

function validatePayload(): boolean {
  try {
    decodePayload(publishData.payload, payloadFormat.value);
    return true;
  } catch {
    const errorKey = payloadFormat.value === "json"
      ? "errors.jsonInvalid"
      : payloadFormat.value === "hex"
        ? "errors.hexInvalid"
        : "errors.base64Invalid";
    ElMessage.warning(t(errorKey));
    return false;
  }
}

// 打开模板管理
const handleOpenTemplates = () => {
  emit("openTemplates");
};

// 打开定时发布
const handleScheduledPublish = () => {
  emit("scheduledPublish");
};

// 定时消息按钮点击
const handleTimedMessage = () => {
  if (props.timedMessageRunning) {
    stopTimedMessage();
  } else {
    // 先验证基本条件
    const topicValidation = validatePublishTopic(publishData.topic);
    if (!topicValidation.valid) {
      ElMessage.warning(topicValidation.error || t('errors.inputTopic'));
      return;
    }
    const serverId = serverStore.activeServerId;
    if (!serverId) {
      ElMessage.warning(t('errors.selectServer'));
      return;
    }
    if (!isConnected.value) {
      ElMessage.warning(t('errors.connectFailed'));
      return;
    }
    timedMessageDialogVisible.value = true;
  }
};

// 开始定时消息
const startTimedMessage = () => {
  // 验证频率
  if (timedMessageInterval.value < 0.1) {
    ElMessage.warning(t('timedMessage.frequencyMin'));
    return;
  }
  if (timedMessageInterval.value > 3600) {
    ElMessage.warning(t('timedMessage.frequencyMax'));
    return;
  }

  if (!validatePayload()) return;

  timedMessageDialogVisible.value = false;
  timedMessageCount.value = 0;
  timedMessageActive = true;
  emit('update:timedMessageRunning', true);

  void runTimedMessageCycle();
};

async function runTimedMessageCycle() {
  await sendOneTimedMessage();
  if (!timedMessageActive) return;

  const intervalMs = Math.round(timedMessageInterval.value * 1000);
  timedMessageTimer = setTimeout(() => {
    timedMessageTimer = null;
    void runTimedMessageCycle();
  }, intervalMs);
}

// 停止定时消息
const stopTimedMessage = () => {
  timedMessageActive = false;
  if (timedMessageTimer) {
    clearTimeout(timedMessageTimer);
    timedMessageTimer = null;
  }
  emit('update:timedMessageRunning', false);
  ElMessage.info(t('timedMessage.stop'));
};

// 发送一条定时消息（不含 loading 状态）
const sendOneTimedMessage = async () => {
  const serverId = serverStore.activeServerId;
  if (!serverId || !isConnected.value) {
    stopTimedMessage();
    return;
  }

  try {
    await doPublishCore();
    timedMessageCount.value++;
  } catch (error: any) {
    // 记录日志，继续下一次发送
    console.error('Timed message failed:', error);
  }
};

// 核心发布逻辑（不含 loading 状态和消息提示）
async function doPublishCore(): Promise<void> {
  const serverId = serverStore.activeServerId;
  if (!serverId) {
    throw new Error(t('errors.selectServer'));
  }

  // 预分配序列号
  const seq = mqttStore.reserveSeq();

  // 确保加载环境变量
  if (envStore.variables.length === 0) {
    await envStore.loadVariables(serverId);
  }

  // 替换环境变量
  const processedTopic = envStore.replaceVariables(publishData.topic);
  let processedPayload = envStore.replaceVariables(publishData.payload);
  let scriptError: string | undefined = undefined;

  // 应用发送前处理脚本
  try {
    const scripts = await invoke<Script[]>("get_enabled_scripts", {
      serverId,
      scriptType: "before_publish",
    });
    if (scripts.length > 0) {
      processedPayload = await ScriptEngine.executeBeforePublish(
        scripts,
        processedPayload,
        processedTopic,
        envStore.variablesMap
      );
    }
  } catch (error: any) {
    // 记录脚本错误
    scriptError = error?.message || String(error);
    handleScriptError(error);

    // 将原始消息添加到列表中（带错误标记，不实际发布）
    mqttStore.addPublishMessage(serverId, {
      topic: processedTopic,
      payload: publishData.payload,
      qos: publishData.qos as 0 | 1 | 2,
      retain: publishData.retain,
      scriptError: scriptError,
      payload_type: payloadFormat.value,
      seq,
    });

    throw error;
  }

  await mqttStore.publishTrackedMessage(serverId, {
    topic: processedTopic,
    payload: processedPayload,
    qos: publishData.qos as 0 | 1 | 2,
    retain: publishData.retain,
    format: payloadFormat.value,
    seq,
  });
}

const handleSaveTemplate = () => {
  if (!publishData.topic.trim()) {
    ElMessage.warning(t('errors.inputTopic'));
    return;
  }
  emit("saveTemplate", {
    topic: publishData.topic,
    payload: publishData.payload,
    qos: publishData.qos,
    retain: publishData.retain,
    payloadType: payloadFormat.value,
  });
};

const handlePublish = async () => {
  // 验证 Topic
  const topicValidation = validatePublishTopic(publishData.topic);
  if (!topicValidation.valid) {
    ElMessage.warning(topicValidation.error || t('errors.inputTopic'));
    return;
  }

  const serverId = serverStore.activeServerId;
  if (!serverId) {
    ElMessage.warning(t('errors.selectServer'));
    return;
  }

  if (!validatePayload()) return;

  publishing.value = true;
  try {
    await doPublishCore();
    ElMessage.success(t('success.published'));
  } catch (error: any) {
    handleMqttError(error?.message || String(error));
  } finally {
    publishing.value = false;
  }
};
</script>

<style scoped lang="scss">
.publish-panel-wrapper {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.publish-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 52px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border-color);
}

.panel-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--app-text-color);

  .el-icon {
    color: var(--primary-color);
  }
}

.panel-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.publish-option,
.retain-option {
  height: 32px;
  border: 1px solid var(--app-border-color);
  border-radius: 6px;
  background-color: var(--card-bg);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.publish-option {
  display: flex;
  align-items: center;
  overflow: hidden;

  &:focus-within {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 2px var(--primary-light);
  }

  :deep(.el-select) {
    height: 100%;
  }

  :deep(.el-select__wrapper) {
    min-height: 30px;
    padding-left: 6px;
    border-radius: 0;
    box-shadow: none !important;
    background-color: transparent;
  }
}

.format-option {
  width: 112px;
}

.qos-option {
  width: 120px;
}

.retain-option {
  display: flex;
  align-items: center;
  min-width: 96px;
  padding: 0 12px;

  :deep(.el-checkbox) {
    height: 100%;
    margin-right: 0;
  }

  :deep(.el-checkbox__label) {
    color: var(--app-text-color);
  }
}

.collapse-button {
  width: 32px;
  height: 32px;
  margin-left: 0;
  color: var(--app-text-secondary);
}

.publish-panel.is-collapsed .panel-header {
  border-bottom: 0;
}

.publish-panel.is-horizontal.is-collapsed .panel-header {
  flex-direction: column;
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 10px;
}

.publish-panel.is-horizontal.is-collapsed .panel-title {
  justify-content: center;
  width: 32px;
  height: 32px;
}

.publish-panel.is-horizontal.is-collapsed .panel-title-label {
  display: none;
}

.publish-panel.is-horizontal.is-collapsed .panel-header-actions {
  width: auto;
}

.publish-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 12px;
  flex: 1;
  min-height: 0;
}

.topic-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.topic-input {
  min-width: 0;

  :deep(.el-input__wrapper) {
    min-height: 32px;
    border-radius: 6px;
  }
}

.btn-timed-message,
.btn-scheduled-publish {
  min-width: 112px;
  height: 32px;
  margin-left: 0 !important;
  border-radius: 6px;
}

.topic-prefix {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text-secondary);

  &::after {
    width: 1px;
    height: 16px;
    background-color: var(--app-border-color);
    content: "";
  }
}

.payload-input-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
}

.payload-format-button {
  position: absolute;
  z-index: 2;
  top: 6px;
  right: 6px;
  width: 28px;
  min-width: 28px;
  height: 28px;
  min-height: 28px;
  margin: 0;
  padding: 0;
  border-radius: 5px;
  color: var(--app-text-secondary);
  background-color: var(--card-bg);

  &:hover,
  &:focus-visible {
    color: var(--primary-color);
    background-color: var(--primary-light);
  }
}

.action-row-bottom {
  display: flex;
  justify-content: flex-end;
  gap: 8px;

  .el-button {
    height: 32px;
    margin-left: 0;
    border-radius: 6px;
  }
}

.icon-action {
  width: 32px;
  padding: 0;
}

.send-button {
  width: 160px;
}

.payload-input {
  height: 100%;
}

.payload-input :deep(.el-textarea),
.payload-input :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 72px;
  padding: 10px 12px;
  border-radius: 6px;
}

.payload-input-wrapper.has-format-action .payload-input :deep(.el-textarea__inner) {
  padding-right: 44px;
}

.is-running {
  :deep(.el-icon) {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.unit {
  margin-left: 8px;
  font-size: 12px;
  color: var(--app-text-secondary);
}

@container (max-width: 600px) {
  .publish-panel:not(.is-collapsed) .panel-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  .publish-panel:not(.is-collapsed) .header-actions {
    width: 100%;
  }

  .publish-panel:not(.is-collapsed) .panel-header-actions {
    width: 100%;
  }

  .publish-option,
  .retain-option {
    flex: 1;
    min-width: 0;
  }

  .topic-row {
    grid-template-columns: 1fr 1fr;
  }

  .topic-input {
    grid-column: 1 / -1;
  }

  .btn-timed-message,
  .btn-scheduled-publish {
    min-width: 0;
  }

}

@container (max-width: 380px) {
  .publish-panel:not(.is-collapsed) .header-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    flex: 1;
  }

  .publish-panel:not(.is-collapsed) .retain-option {
    grid-column: 1 / -1;
  }

  .topic-row {
    grid-template-columns: 1fr;
  }

  .topic-input {
    grid-column: auto;
  }

  .btn-timed-message,
  .btn-scheduled-publish {
    width: 100%;
  }
}
</style>
