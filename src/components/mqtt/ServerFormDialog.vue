<template>
  <el-dialog
    :model-value="visible"
    :title="isEdit ? $t('server.editTitle') : $t('server.addTitle')"
    width="600px"
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <el-form
      ref="formRef"
      :model="formData"
      :rules="rules"
      label-width="110px"
      label-position="right"
    >
      <el-tabs v-model="activeTab">
        <!-- 基本配置 -->
        <el-tab-pane :label="$t('server.name')" name="basic">
          <el-form-item :label="$t('server.name')" prop="name">
            <el-input v-model="formData.name" :placeholder="$t('server.namePlaceholder')" />
          </el-form-item>

          <!-- 服务器地址：协议 + 主机 + 端口 -->
          <el-form-item :label="$t('server.host')" required>
            <div class="address-input">
              <el-select v-model="formData.protocol" class="protocol-select">
                <el-option label="mqtt://" value="mqtt" />
                <el-option label="mqtts://" value="mqtts" />
                <el-option label="ws://" value="ws" />
                <el-option label="wss://" value="wss" />
              </el-select>
              <el-form-item prop="host" class="host-input" style="margin-bottom: 0">
                <el-input v-model="formData.host" :placeholder="$t('server.hostPlaceholder')" />
              </el-form-item>
              <span class="separator">:</span>
              <el-form-item prop="port" class="port-input" style="margin-bottom: 0">
                <el-input-number
                  v-model="formData.port"
                  :min="1"
                  :max="65535"
                  :controls="false"
                  :placeholder="$t('server.port')"
                />
              </el-form-item>
            </div>
          </el-form-item>

          <el-form-item
            v-if="formData.protocol === 'ws' || formData.protocol === 'wss'"
            :label="$t('server.websocketPath')"
            prop="websocket_path"
          >
            <el-input v-model="formData.websocket_path" :placeholder="$t('server.websocketPathPlaceholder')" />
          </el-form-item>

          <el-form-item :label="$t('server.protocol')" prop="protocol_version">
            <el-radio-group v-model="formData.protocol_version">
              <el-radio value="3.1.1">MQTT 3.1.1</el-radio>
              <el-radio value="5.0">MQTT 5.0</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item :label="$t('server.clientId')" prop="client_id">
            <el-input v-model="formData.client_id" :placeholder="$t('server.clientIdPlaceholder')">
              <template #append>
                <el-button @click="generateClientId">
                  <el-icon><RefreshRight /></el-icon>
                </el-button>
              </template>
            </el-input>
          </el-form-item>
        </el-tab-pane>

        <!-- 认证配置 -->
        <el-tab-pane :label="$t('server.username')" name="auth">
          <el-form-item :label="$t('server.username')" prop="username">
            <el-input v-model="formData.username" :placeholder="$t('server.usernamePlaceholder')" />
          </el-form-item>

          <el-form-item :label="$t('server.password')" prop="password">
            <el-input
              v-model="formData.password"
              type="password"
              :placeholder="$t('server.passwordPlaceholder')"
              show-password
            />
          </el-form-item>
        </el-tab-pane>

        <!-- 高级配置 -->
        <el-tab-pane :label="$t('server.advanced')" name="advanced">
          <el-form-item :label="$t('server.keepAlive')" prop="keep_alive">
            <div class="keep-alive-input">
              <el-input-number v-model="formData.keep_alive" :min="0" :max="65535" />
              <span class="unit-label">{{ $t('server.keepAliveUnit') }}</span>
            </div>
          </el-form-item>
          <el-form-item :label="$t('server.cleanSession')">
            <el-switch v-model="formData.clean_session" />
          </el-form-item>

          <el-form-item :label="$t('server.useTls')">
            <el-switch v-model="formData.use_tls" />
          </el-form-item>

          <template v-if="showTlsSection">
            <div class="tls-section">
              <div class="tls-section__title">{{ $t('server.tls.title') }}</div>

              <el-form-item :label="$t('server.tls.sslSecure')" prop="ssl_secure">
                <div class="tls-switch-row">
                  <el-switch v-model="formData.ssl_secure" />
                  <span class="form-hint">{{ $t('server.tls.sslSecureHint') }}</span>
                </div>
              </el-form-item>

              <el-form-item :label="$t('server.tls.alpn')" prop="alpn">
                <el-input
                  v-model="formData.alpn"
                  :placeholder="$t('server.tls.alpnPlaceholder')"
                />
              </el-form-item>

              <el-form-item :label="$t('server.tls.certificate')" prop="certificate_type">
                <el-radio-group v-model="formData.certificate_type">
                  <el-radio value="ca_signed">{{ $t('server.tls.certificateTypes.caSigned') }}</el-radio>
                  <el-radio value="self_signed">{{ $t('server.tls.certificateTypes.selfSigned') }}</el-radio>
                </el-radio-group>
              </el-form-item>

              <template v-if="showCertificateFields">
                <el-form-item :label="$t('server.tls.caCert')" prop="ca_cert">
                  <el-input
                    v-model="formData.ca_cert"
                    type="textarea"
                    :rows="3"
                    :placeholder="$t('server.tls.caCertPlaceholder')"
                  />
                </el-form-item>

                <el-form-item :label="$t('server.tls.clientCert')" prop="client_cert">
                  <el-input
                    v-model="formData.client_cert"
                    type="textarea"
                    :rows="3"
                    :placeholder="$t('server.tls.clientCertPlaceholder')"
                  />
                </el-form-item>

                <el-form-item :label="$t('server.tls.clientKey')" prop="client_key">
                  <el-input
                    v-model="formData.client_key"
                    type="textarea"
                    :rows="3"
                    :placeholder="$t('server.tls.clientKeyPlaceholder')"
                  />
                </el-form-item>

                <el-form-item :label="$t('server.tls.keyPassword')" prop="client_key_password">
                  <el-input
                    v-model="formData.client_key_password"
                    type="password"
                    :placeholder="$t('server.tls.keyPasswordPlaceholder')"
                    show-password
                  />
                </el-form-item>
              </template>
            </div>
          </template>
        </el-tab-pane>
      </el-tabs>
    </el-form>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">{{ $t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">
        {{ $t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed, reactive } from "vue";
import { useI18n } from "vue-i18n";
import type { FormInstance, FormRules } from "element-plus";
import { RefreshRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useServerStore } from "@/stores/server";
import type { MqttCertificateType, MqttServer } from "@/types/mqtt";

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  server?: MqttServer | null;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  saved: [];
}>();

const serverStore = useServerStore();
const formRef = ref<FormInstance>();
const activeTab = ref("basic");
const saving = ref(false);

const isEdit = computed(() => !!props.server?.id);

// 表单数据
interface FormData {
  id?: number;
  name: string;
  protocol: "mqtt" | "mqtts" | "ws" | "wss";
  host: string;
  port: number;
  websocket_path?: string;
  protocol_version: "3.1.1" | "5.0";
  username?: string;
  password?: string;
  client_id?: string;
  keep_alive: number;
  clean_session: boolean;
  use_tls: boolean;
  ssl_secure: boolean;
  alpn: string;
  certificate_type: MqttCertificateType;
  ca_cert?: string;
  client_cert?: string;
  client_key?: string;
  client_key_password?: string;
}

const formData = reactive<FormData>({
  name: "",
  protocol: "mqtt",
  host: "",
  port: 1883,
  websocket_path: "",
  protocol_version: "5.0",
  username: "",
  password: "",
  client_id: "",
  keep_alive: 60,
  clean_session: true,
  use_tls: false,
  ssl_secure: true,
  alpn: "",
  certificate_type: "ca_signed",
  ca_cert: "",
  client_cert: "",
  client_key: "",
  client_key_password: "",
});

const isTlsCapableProtocol = computed(() => formData.protocol === "mqtts" || formData.protocol === "wss");
const showTlsSection = computed(() => isTlsCapableProtocol.value || formData.use_tls);
const showCertificateFields = computed(() => formData.certificate_type === "self_signed");

// 协议变化时自动更新端口和TLS
watch(() => formData.protocol, (newProtocol, oldProtocol) => {
  switch (newProtocol) {
    case "mqtt":
      if (oldProtocol === "mqtts" || oldProtocol === "mqtt" || formData.port === 8883) {
        formData.port = 1883;
      }
      formData.use_tls = false;
      break;
    case "mqtts":
      if (oldProtocol === "mqtt" || oldProtocol === "mqtts" || formData.port === 1883) {
        formData.port = 8883;
      }
      formData.use_tls = true;
      break;
    case "ws":
      if (oldProtocol === "wss" || oldProtocol === "ws" || formData.port === 8084) {
        formData.port = 8083;
      }
      formData.use_tls = false;
      break;
    case "wss":
      if (oldProtocol === "ws" || oldProtocol === "wss" || formData.port === 8083) {
        formData.port = 8084;
      }
      formData.use_tls = true;
      break;
  }
});

watch(() => formData.use_tls, (useTls) => {
  if (useTls) {
    if (formData.protocol === "mqtt") {
      formData.protocol = "mqtts";
    } else if (formData.protocol === "ws") {
      formData.protocol = "wss";
    }
    return;
  }

  if (formData.protocol === "mqtts") {
    formData.protocol = "mqtt";
  } else if (formData.protocol === "wss") {
    formData.protocol = "ws";
  }
});

const rules = computed<FormRules>(() => ({
  name: [
    { required: true, message: t('errors.inputName'), trigger: "blur" },
  ],
  host: [
    { required: true, message: t('server.hostPlaceholder'), trigger: "blur" },
  ],
  port: [
    { required: true, message: t('server.port'), trigger: "blur" },
  ],
}));

watch(
  () => props.visible,
  (val) => {
    if (val) {
      activeTab.value = "basic";
      if (props.server) {
        // 编辑模式
        formData.id = props.server.id;
        formData.name = props.server.name;
        formData.host = props.server.host;
        formData.protocol = props.server.protocol || (props.server.use_tls ? "mqtts" : "mqtt");
        formData.port = props.server.port;
        formData.websocket_path = props.server.websocket_path || "";
        formData.protocol_version = props.server.protocol_version;
        formData.username = props.server.username || "";
        formData.password = props.server.password || "";
        formData.client_id = props.server.client_id || "";
        formData.keep_alive = props.server.keep_alive;
        formData.clean_session = props.server.clean_session;
        formData.use_tls = props.server.use_tls;
        formData.ssl_secure = props.server.ssl_secure ?? true;
        formData.alpn = props.server.alpn || "";
        formData.certificate_type = props.server.certificate_type === "self_signed" ? "self_signed" : "ca_signed";
        formData.ca_cert = props.server.ca_cert || "";
        formData.client_cert = props.server.client_cert || "";
        formData.client_key = props.server.client_key || "";
        formData.client_key_password = props.server.client_key_password || "";
      } else {
        // 新增模式：重置表单
        formData.id = undefined;
        formData.name = "";
        formData.protocol = "mqtt";
        formData.host = "";
        formData.port = 1883;
        formData.websocket_path = "";
        formData.protocol_version = "5.0";
        formData.username = "";
        formData.password = "";
        formData.client_id = "";
        formData.keep_alive = 60;
        formData.clean_session = true;
        formData.use_tls = false;
        formData.ssl_secure = true;
        formData.alpn = "";
        formData.certificate_type = "ca_signed";
        formData.ca_cert = "";
        formData.client_cert = "";
        formData.client_key = "";
        formData.client_key_password = "";
      }
    }
  }
);

const generateClientId = () => {
  const random = Math.random().toString(36).substring(2, 10);
  formData.client_id = `mqtt_${Date.now()}_${random}`;
};

const handleSave = async () => {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const serverData: MqttServer = {
    id: formData.id,
    name: formData.name,
    host: formData.host,
    port: formData.port,
    protocol: formData.protocol,
    websocket_path: formData.websocket_path || undefined,
    protocol_version: formData.protocol_version,
    username: formData.username || undefined,
    password: formData.password || undefined,
    client_id: formData.client_id || undefined,
    keep_alive: formData.keep_alive,
    clean_session: formData.clean_session,
    use_tls: formData.use_tls,
    ssl_secure: formData.ssl_secure,
    alpn: formData.alpn.trim() || undefined,
    certificate_type: formData.certificate_type,
    ca_cert: formData.ca_cert || undefined,
    client_cert: formData.client_cert || undefined,
    client_key: formData.client_key || undefined,
    client_key_password: formData.client_key_password || undefined,
  };

  saving.value = true;
  try {
    if (isEdit.value) {
      await serverStore.updateServer(serverData);
      ElMessage.success(t('server.saveSuccess'));
    } else {
      await serverStore.createServer(serverData);
      ElMessage.success(t('server.saveSuccess'));
    }
    emit("saved");
    emit("update:visible", false);
  } catch (error) {
    ElMessage.error(`${t('errors.saveFailed')}: ${error}`);
  } finally {
    saving.value = false;
  }
};
</script>

<style scoped lang="scss">
:deep(.el-tabs__content) {
  padding-top: 16px;
}

.address-input {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.protocol-select {
  width: 120px;
  flex-shrink: 0;
}

.host-input {
  flex: 1;
}

.separator {
  color: var(--app-text-secondary);
  font-weight: 500;
}

.port-input {
  width: 100px;
  flex-shrink: 0;
}

.form-hint {
  font-size: 12px;
  color: var(--app-text-secondary);
}

.keep-alive-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.unit-label {
  font-size: 13px;
  color: var(--app-text-secondary);
}

.tls-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tls-section__title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-primary);
}

.tls-switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
</style>
