<template>
  <div class="publish-panel-wrapper">
    <div class="publish-panel app-card">
      <div class="panel-header">
      <span class="panel-title">
        <el-icon><Promotion /></el-icon>
        {{ $t('publish.send') }}
      </span>
      <div class="header-actions">
        <el-select v-model="payloadFormat" size="small" style="width: 90px">
          <el-option
            v-for="opt in formatOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-select v-model="publishData.qos" size="small" style="width: 100px">
          <el-option :value="0" label="QoS 0" />
          <el-option :value="1" label="QoS 1" />
          <el-option :value="2" label="QoS 2" />
        </el-select>
        <el-checkbox v-model="publishData.retain">Retain</el-checkbox>
      </div>
    </div>

    <div class="publish-form">
      <div class="form-row payload-row">
        <!-- 左列：Topic 输入 -->
        <div class="topic-input">
          <el-input
            v-model="publishData.topic"
            :placeholder="$t('publish.topicPlaceholder')"
            size="default"
          >
            <template #prefix>
              <el-icon><Position /></el-icon>
            </template>
          </el-input>
        </div>

        <!-- 左列：Payload 输入 -->
        <div class="payload-input-wrapper">
          <el-input
            v-model="publishData.payload"
            type="textarea"
            :placeholder="payloadPlaceholder"
            resize="none"
            class="payload-input"
          />
        </div>

        <!-- 右列：定时消息 -->
        <el-button
          class="btn-timed-message"
          :icon="props.timedMessageRunning ? Loading : Timer"
          :type="props.timedMessageRunning ? 'danger' : 'default'"
          :class="{ 'is-running': props.timedMessageRunning }"
          @click="handleTimedMessage"
        >
          {{ props.timedMessageRunning ? $t('timedMessage.stop') : $t('publish.timedMessage') }}
        </el-button>

        <!-- 右列：定时发布 -->
        <el-button
          class="btn-scheduled-publish"
          :icon="props.scheduledPublishRunning ? Loading : Timer"
          :type="props.scheduledPublishRunning ? 'primary' : 'default'"
          :class="{ 'is-running': props.scheduledPublishRunning }"
          @click="handleScheduledPublish"
        >
          {{ props.scheduledPublishRunning ? $t('scheduled.running') : $t('publish.scheduledPublish') }}
        </el-button>

        <!-- 右列底：模板/收藏/发送 -->
        <div class="action-row-bottom">
          <el-tooltip :content="$t('publish.openTemplates')" placement="top">
            <el-button :icon="FolderOpened" @click="handleOpenTemplates" />
          </el-tooltip>
          <el-tooltip :content="$t('publish.saveTemplate')" placement="top">
            <el-button :icon="Star" @click="handleSaveTemplate" />
          </el-tooltip>
          <el-button
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
import { Promotion, Position, Star, FolderOpened, Timer, Loading } from "@element-plus/icons-vue";
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

const { t } = useI18n();

type PayloadFormat = "json" | "hex" | "text";

const props = defineProps<{
  scheduledPublishRunning: boolean;
  timedMessageRunning: boolean;
}>();

const formatOptions = [
  { label: "JSON", value: "json" },
  { label: "HEX", value: "hex" },
  { label: "Text", value: "text" },
];

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
  saveTemplate: [data: { topic: string; payload: string; qos: number; retain: boolean; payloadType: string }]
  openTemplates: []
  scheduledPublish: []
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
        payloadFormat.value = data.payloadType as PayloadFormat;
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

  // 验证格式
  if (payloadFormat.value === "hex") {
    const hex = publishData.payload.replace(/\s/g, "");
    if (!/^[0-9A-Fa-f]*$/.test(hex)) {
      ElMessage.warning(t('errors.hexInvalid'));
      return;
    }
  }

  if (payloadFormat.value === "json" && publishData.payload.trim()) {
    try {
      JSON.parse(publishData.payload);
    } catch {
      ElMessage.warning(t('errors.jsonInvalid'));
      return;
    }
  }

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

  // 验证格式
  if (payloadFormat.value === "hex") {
    const hex = publishData.payload.replace(/\s/g, "");
    if (!/^[0-9A-Fa-f]*$/.test(hex)) {
      ElMessage.warning(t('errors.hexInvalid'));
      return;
    }
  }

  if (payloadFormat.value === "json" && publishData.payload.trim()) {
    try {
      JSON.parse(publishData.payload);
    } catch {
      ElMessage.warning(t('errors.jsonInvalid'));
      return;
    }
  }

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
.publish-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border-color);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text-color);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.publish-form {
  padding: 12px 16px;
  flex: 1;
  min-height: 0;
}

.payload-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto 1fr;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.topic-input {
  grid-column: 1;
  grid-row: 1;
}

.payload-input-wrapper {
  grid-column: 1;
  grid-row: 2 / 4;
  min-height: 0;
}

.btn-timed-message {
  grid-column: 2;
  grid-row: 1;
}

.btn-scheduled-publish {
  grid-column: 2;
  grid-row: 2;
  margin-left: 0 !important;
}

.action-row-bottom {
  grid-column: 2;
  grid-row: 3;
  display: flex;
  gap: 10px;
  align-self: end;

  .el-button {
    flex: 1;
  }
}

.payload-input {
  height: 100%;
}

.payload-input :deep(.el-textarea),
.payload-input :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 96px;
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
</style>
