<template>
  <div class="sidebar">
    <!-- Logo 区域 -->
    <div class="sidebar-header">
      <div class="logo">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span class="logo-text">MQTT Client</span>
        <span 
          class="version-tag" 
          :class="{ 'has-update': appStore.updateInfo?.hasUpdate }"
          @click="handleVersionClick"
        >
          v{{ appVersion }}
          <span v-if="appStore.updateInfo?.hasUpdate" class="update-dot" />
        </span>
      </div>
    </div>

    <div class="sidebar-content">
      <!-- Server 列表区域 -->
      <div class="section">
        <div class="section-header">
          <div class="section-title-wrapper" @click="isServerListCollapsed = !isServerListCollapsed">
            <el-icon class="collapse-icon" :class="{ collapsed: isServerListCollapsed }">
              <CaretBottom />
            </el-icon>
            <span class="section-title">{{ $t('sidebar.server') }}</span>
          </div>
          <el-dropdown trigger="click" @command="handleCreateMenuCommand">
            <el-button type="primary" size="small" :icon="Plus" circle />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="connection">
                  <el-icon><Connection /></el-icon>
                  <span>{{ $t('sidebar.addConnection') }}</span>
                </el-dropdown-item>
                <el-dropdown-item command="group">
                  <el-icon><FolderAdd /></el-icon>
                  <span>{{ $t('sidebar.addGroup') }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <div class="server-list" v-show="!isServerListCollapsed">
          <div v-if="ungroupedServers.length > 0" class="server-group">
            <div class="group-header group-header--static">
              <span class="group-label">{{ $t('sidebar.ungrouped') }}</span>
            </div>
            <div class="group-body">
              <div
                v-for="serverState in ungroupedServers"
                :key="serverState.server.id"
                class="server-item"
                :class="{ active: serverState.server.id === serverStore.activeServerId }"
                @click="handleSelectServer(serverState.server.id!)"
              >
                <span class="status-indicator" :class="getConnectionClass(serverState.server.id!)" />
                <div class="server-info">
                  <span class="server-name text-ellipsis">{{ serverState.server.name }}</span>
                  <span class="server-host text-ellipsis">
                    {{ formatServerAddress(serverState.server) }}
                  </span>
                </div>
                <el-dropdown trigger="click" @command="(cmd: string) => handleServerAction(cmd, serverState.server)">
                  <el-button :icon="MoreFilled" text size="small" class="more-btn" @click.stop />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="edit">
                        <el-icon><Edit /></el-icon>
                        <span>{{ $t('sidebar.actions.edit') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="duplicate">
                        <el-icon><CopyDocument /></el-icon>
                        <span>{{ $t('sidebar.actions.duplicate') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="move">
                        <el-icon><FolderOpened /></el-icon>
                        <span>{{ $t('sidebar.actions.moveToGroup') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" divided>
                        <el-icon><Delete /></el-icon>
                        <span style="color: var(--el-color-danger)">{{ $t('sidebar.actions.delete') }}</span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </div>

          <div
            v-for="group in groupedServers"
            :key="group.id"
            class="server-group"
          >
            <div class="group-header" @click="toggleGroup(group.id)">
              <div class="group-title">
                <el-icon class="collapse-icon collapse-icon--group" :class="{ collapsed: group.collapsed }">
                  <CaretBottom />
                </el-icon>
                <el-icon class="group-folder-icon"><Folder /></el-icon>
                <span class="group-label text-ellipsis">{{ group.name }}</span>
                <span class="group-count">{{ group.servers.length }}</span>
              </div>
              <el-dropdown
                trigger="click"
                @command="(cmd: string) => handleGroupAction(cmd, group.id)"
              >
                <el-button :icon="MoreFilled" text size="small" class="more-btn group-more-btn" @click.stop />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="addConnection">
                      <el-icon><Connection /></el-icon>
                      <span>{{ $t('sidebar.addConnection') }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item command="rename">
                      <el-icon><Edit /></el-icon>
                      <span>{{ $t('sidebar.actions.renameGroup') }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item command="delete" divided>
                      <el-icon><Delete /></el-icon>
                      <span style="color: var(--el-color-danger)">{{ $t('sidebar.actions.deleteGroup') }}</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>

            <div v-show="!group.collapsed" class="group-body">
              <div
                v-for="serverState in group.servers"
                :key="serverState.server.id"
                class="server-item server-item--nested"
                :class="{ active: serverState.server.id === serverStore.activeServerId }"
                @click="handleSelectServer(serverState.server.id!)"
              >
                <span class="status-indicator" :class="getConnectionClass(serverState.server.id!)" />
                <div class="server-info">
                  <span class="server-name text-ellipsis">{{ serverState.server.name }}</span>
                  <span class="server-host text-ellipsis">
                    {{ formatServerAddress(serverState.server) }}
                  </span>
                </div>
                <el-dropdown trigger="click" @command="(cmd: string) => handleServerAction(cmd, serverState.server)">
                  <el-button :icon="MoreFilled" text size="small" class="more-btn" @click.stop />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="edit">
                        <el-icon><Edit /></el-icon>
                        <span>{{ $t('sidebar.actions.edit') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="duplicate">
                        <el-icon><CopyDocument /></el-icon>
                        <span>{{ $t('sidebar.actions.duplicate') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="move">
                        <el-icon><FolderOpened /></el-icon>
                        <span>{{ $t('sidebar.actions.moveToGroup') }}</span>
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" divided>
                        <el-icon><Delete /></el-icon>
                        <span style="color: var(--el-color-danger)">{{ $t('sidebar.actions.delete') }}</span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </div>

          <!-- 空状态 -->
          <div v-if="serverStore.servers.length === 0" class="empty-state">
            <el-empty :description="$t('sidebar.noServer')" :image-size="60">
              <el-button type="primary" size="small" @click="handleAddServer()">
                {{ $t('sidebar.addConnection') }}
              </el-button>
            </el-empty>
          </div>
        </div>
      </div>

      <!-- 分隔线 -->
      <el-divider v-if="serverStore.activeServer" />

      <!-- 订阅列表区域 -->
      <div v-if="serverStore.activeServer" class="section">
        <div class="section-header">
          <div class="section-title-wrapper" @click="isSubscriptionListCollapsed = !isSubscriptionListCollapsed">
            <el-icon class="collapse-icon" :class="{ collapsed: isSubscriptionListCollapsed }">
              <CaretBottom />
            </el-icon>
            <span class="section-title">{{ $t('sidebar.subscription') }}</span>
          </div>
          <el-button type="primary" size="small" :icon="Plus" circle @click="handleAddSubscription" />
        </div>

        <div class="subscription-list" v-show="!isSubscriptionListCollapsed">
          <div
            v-for="sub in currentSubscriptions"
            :key="sub.id"
            class="subscription-item"
            :class="{
              inactive: !sub.is_active,
              pending: isSubscriptionPending(sub),
              failed: getSubscriptionRuntimeState(sub)?.status === 'failed',
            }"
          >
            <!-- 第一行：颜色 + Topic + 开关 -->
            <div class="sub-row-1">
              <span 
                v-if="sub.color" 
                class="sub-color-indicator" 
                :style="{ backgroundColor: sub.color }"
              />
              <el-tooltip :content="sub.topic" placement="top" :show-after="500">
                <span class="sub-topic text-ellipsis">{{ sub.topic }}</span>
              </el-tooltip>
              <el-switch
                :model-value="sub.is_active"
                size="small"
                :disabled="isSubscriptionPending(sub)"
                @change="(val: string | number | boolean) => handleToggleSubscription(sub, Boolean(val))"
              />
            </div>
            <!-- 第二行：QoS + 操作按钮 -->
            <div class="sub-row-2">
              <div class="subscription-runtime">
                <el-icon v-if="isSubscriptionPending(sub)" class="subscription-state-icon pending-icon">
                  <Loading />
                </el-icon>
                <el-tooltip
                  v-else-if="getSubscriptionRuntimeState(sub)?.status === 'failed'"
                  :content="getSubscriptionRuntimeState(sub)?.error"
                  placement="top"
                >
                  <el-icon class="subscription-state-icon failed-icon">
                    <WarningFilled />
                  </el-icon>
                </el-tooltip>
                <el-tag
                  size="small"
                  effect="plain"
                  :type="getSubscriptionQosTagType(sub)"
                >
                  {{ getSubscriptionQosLabel(sub) }}
                </el-tag>
              </div>
              <div class="sub-actions">
                <el-button text size="small" :icon="Edit" :disabled="isSubscriptionPending(sub)" @click="handleEditSubscription(sub)" />
                <el-button text size="small" type="danger" :icon="Close" :disabled="isSubscriptionPending(sub)" @click="handleDeleteSubscription(sub)" />
              </div>
            </div>
          </div>

          <div v-if="currentSubscriptions.length === 0" class="empty-hint">
            {{ $t('sidebar.addSubscriptionHint') }}
          </div>
        </div>
      </div>
    </div>

    <!-- 底部 -->
    <div class="sidebar-footer">
      <el-button text @click="appStore.toggleTheme" class="theme-btn">
        <el-icon>
          <Sunny v-if="appStore.theme === 'light'" />
          <Moon v-else-if="appStore.theme === 'dark'" />
          <Platform v-else />
        </el-icon>
        <span>{{ themeLabel }}</span>
      </el-button>
    </div>

    <!-- Server 表单对话框 -->
    <ServerFormDialog
      v-model:visible="showServerDialog"
      :server="editingServer"
      :initial-group-id="pendingGroupId"
      @saved="handleServerSaved"
    />

    <!-- 订阅对话框 -->
    <el-dialog
      v-model="showSubDialog"
      :title="isEditingSubscription ? $t('sidebar.editSubscription') : $t('sidebar.addSubscription')"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form :model="subFormData" label-width="80px">
        <el-form-item :label="$t('sidebar.topic')">
          <el-input v-model="subFormData.topic" placeholder="e.g., sensor/+/temperature" />
        </el-form-item>
        <el-form-item :label="$t('publish.qos')">
          <el-radio-group v-model="subFormData.qos">
            <el-radio-button :value="0">QoS 0</el-radio-button>
            <el-radio-button :value="1">QoS 1</el-radio-button>
            <el-radio-button :value="2">QoS 2</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="$t('sidebar.colorMark')">
          <div class="color-picker-container">
            <div class="color-options">
              <div
                v-for="color in colorOptions"
                :key="color"
                class="color-option"
                :class="{ active: subFormData.color === color }"
                :style="{ backgroundColor: color }"
                @click="subFormData.color = color"
              />
              <div
                class="color-option no-color"
                :class="{ active: !subFormData.color }"
                @click="subFormData.color = ''"
                :title="$t('sidebar.noColor')"
              >
                <el-icon><Close /></el-icon>
              </div>
            </div>
            <el-color-picker
              v-model="subFormData.color"
              size="small"
              show-alpha
              :predefine="colorOptions"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showSubDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="subLoading" @click="handleConfirmSubscription">
          {{ isEditingSubscription ? $t('common.save') : $t('sidebar.subscribe') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showMoveServerDialog"
      :title="$t('sidebar.actions.moveToGroup')"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form label-width="90px">
        <el-form-item :label="$t('server.name')">
          <span class="move-server-name">{{ movingServer?.name }}</span>
        </el-form-item>
        <el-form-item :label="$t('server.group')">
          <el-select
            v-model="movingTargetGroupId"
            style="width: 100%"
            :placeholder="$t('server.groupPlaceholder')"
          >
            <el-option :label="$t('sidebar.ungrouped')" value="__ungrouped__" />
            <el-option
              v-for="group in serverStore.groups"
              :key="group.id"
              :label="group.name"
              :value="group.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showMoveServerDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" @click="handleConfirmMoveServer">
          {{ $t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getVersion } from "@tauri-apps/api/app";
import {
  Plus,
  MoreFilled,
  Edit,
  Delete,
  Close,
  CopyDocument,
  Connection,
  Moon,
  Sunny,
  Platform,
  CaretBottom,
  Folder,
  FolderAdd,
  FolderOpened,
  Loading,
  WarningFilled,
} from "@element-plus/icons-vue";
import { useAppStore } from "@/stores/app";
import { useServerStore } from "@/stores/server";
import { useSubscriptionStore } from "@/stores/subscription";
import { useMqttStore } from "@/stores/mqtt";
import { ElMessage, ElMessageBox } from "element-plus";
import ServerFormDialog from "@/components/mqtt/ServerFormDialog.vue";
import type { MqttServer, Subscription } from "@/types/mqtt";

const { t } = useI18n();

const appStore = useAppStore();
const serverStore = useServerStore();
const subscriptionStore = useSubscriptionStore();
const mqttStore = useMqttStore();
const appVersion = ref("");
const isServerListCollapsed = ref(false);
const isSubscriptionListCollapsed = ref(false);
const pendingGroupId = ref<string | null>(null);

// 格式化服务器地址为 协议://host:port 格式
const formatServerAddress = (server: MqttServer): string => {
  const protocol = server.protocol ?? (server.use_tls ? "mqtts" : "mqtt");
  const address = `${protocol}://${server.host}:${server.port}`;

  if ((protocol === "ws" || protocol === "wss") && server.websocket_path?.trim()) {
    const path = server.websocket_path.trim();
    return path.startsWith("/") ? `${address}${path}` : `${address}/${path}`;
  }

  return address;
};

// 获取连接状态样式类
const getConnectionClass = (serverId: number): string => {
  return mqttStore.getConnectionStatus(serverId);
};

// 当前服务器的订阅列表
const currentSubscriptions = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return [];
  return subscriptionStore.getSubscriptionsByServer(serverId);
});

const getSubscriptionRuntimeState = (sub: Subscription) => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return undefined;
  return mqttStore.getSubscriptionState(serverId, sub.topic);
};

const isSubscriptionPending = (sub: Subscription): boolean =>
  getSubscriptionRuntimeState(sub)?.status === "pending";

const getSubscriptionQosLabel = (sub: Subscription): string => {
  const state = getSubscriptionRuntimeState(sub);
  if (state?.status !== "active" || state.granted_qos === undefined) {
    return `Q${sub.qos}`;
  }
  return state.granted_qos === sub.qos
    ? `Q${state.granted_qos}`
    : `Q${sub.qos} → Q${state.granted_qos}`;
};

const getSubscriptionQosTagType = (sub: Subscription) => {
  switch (getSubscriptionRuntimeState(sub)?.status) {
    case "active":
      return "success";
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "info";
  }
};

const ungroupedServers = computed(() => {
  return serverStore.servers.filter(
    (serverState) => !serverStore.getGroupIdForServer(serverState.server.id)
  );
});

const groupedServers = computed(() => {
  return serverStore.groups.map((group) => ({
    id: group.id,
    name: group.name,
    collapsed: serverStore.isGroupCollapsed(group.id),
    servers: serverStore.servers.filter(
      (serverState) => serverStore.getGroupIdForServer(serverState.server.id) === group.id
    ),
  }));
});

// 主题标签文字
const themeLabel = computed(() => {
  switch (appStore.theme) {
    case 'light':
      return t('sidebar.theme.light');
    case 'dark':
      return t('sidebar.theme.dark');
    case 'auto':
      return t('sidebar.theme.auto');
    default:
      return t('sidebar.theme.light');
  }
});

// 初始化加载 Server 列表和版本号
onMounted(async () => {
  serverStore.fetchServers();
  try {
    appVersion.value = await getVersion();
  } catch {
    appVersion.value = "1.0.0";
  }
  
  // 启动时检查更新
  appStore.checkUpdate();
});

// 监听活动服务器变化，加载订阅列表
watch(
  () => serverStore.activeServerId,
  (serverId) => {
    if (serverId) {
      subscriptionStore.fetchSubscriptions(serverId);
    }
  },
  { immediate: true }
);

// ===== Server 相关 =====
const showServerDialog = ref(false);
const editingServer = ref<MqttServer | null>(null);
const showMoveServerDialog = ref(false);
const movingServer = ref<MqttServer | null>(null);
const movingTargetGroupId = ref("__ungrouped__");

const handleAddServer = (groupId: string | null = null) => {
  pendingGroupId.value = groupId;
  editingServer.value = null;
  showServerDialog.value = true;
};

const handleCreateMenuCommand = (command: string) => {
  if (command === "connection") {
    handleAddServer();
    return;
  }

  if (command === "group") {
    handleAddGroup();
  }
};

const handleSelectServer = (id: number) => {
  serverStore.setActiveServer(id);
};

const handleServerAction = async (command: string, server: MqttServer) => {
  switch (command) {
    case "edit":
      pendingGroupId.value = serverStore.getGroupIdForServer(server.id);
      editingServer.value = server;
      showServerDialog.value = true;
      break;
    case "duplicate":
      await serverStore.duplicateServer(server.id!);
      ElMessage.success(t('server.duplicateSuccess'));
      break;
    case "move":
      await handleMoveServer(server);
      break;
    case "delete":
      try {
        await ElMessageBox.confirm(
          t('sidebar.deleteServerConfirm', { name: server.name }),
          t('common.confirm'),
          {
            confirmButtonText: t('common.delete'),
            cancelButtonText: t('common.cancel'),
            type: "warning",
          }
        );
        await serverStore.removeServer(server.id!);
        ElMessage.success(t('server.deleteSuccess'));
      } catch {
        // 用户取消
      }
      break;
  }
};

const handleServerSaved = () => {
  pendingGroupId.value = null;
};

const handleAddGroup = async () => {
  try {
    const { value } = await ElMessageBox.prompt(
      t('sidebar.groupNamePrompt'),
      t('sidebar.addGroup'),
      {
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        inputPattern: /\S+/,
        inputErrorMessage: t('errors.inputName'),
      }
    );

    const name = value.trim();
    if (!name) return;
    serverStore.createGroup(name);
    ElMessage.success(t('sidebar.groupCreated'));
  } catch {
    // 用户取消
  }
};

const toggleGroup = (groupId: string) => {
  serverStore.toggleGroupCollapsed(groupId);
};

const handleGroupAction = async (command: string, groupId: string) => {
  const group = serverStore.groups.find((item) => item.id === groupId);
  if (!group) return;

  switch (command) {
    case "addConnection":
      handleAddServer(groupId);
      break;
    case "rename":
      try {
        const { value } = await ElMessageBox.prompt(
          t('sidebar.groupRenamePrompt'),
          t('sidebar.actions.renameGroup'),
          {
            confirmButtonText: t('common.save'),
            cancelButtonText: t('common.cancel'),
            inputValue: group.name,
            inputPattern: /\S+/,
            inputErrorMessage: t('errors.inputName'),
          }
        );

        const name = value.trim();
        if (!name) return;
        serverStore.renameGroup(groupId, name);
        ElMessage.success(t('success.saved'));
      } catch {
        // 用户取消
      }
      break;
    case "delete":
      try {
        await ElMessageBox.confirm(
          t('sidebar.deleteGroupConfirm', { name: group.name }),
          t('common.confirm'),
          {
            confirmButtonText: t('common.delete'),
            cancelButtonText: t('common.cancel'),
            type: "warning",
          }
        );
        serverStore.deleteGroup(groupId);
        ElMessage.success(t('success.deleted'));
      } catch {
        // 用户取消
      }
      break;
  }
};

const handleMoveServer = async (server: MqttServer) => {
  const currentGroupId = serverStore.getGroupIdForServer(server.id);
  movingServer.value = server;
  movingTargetGroupId.value = currentGroupId ?? "__ungrouped__";
  showMoveServerDialog.value = true;
};

const handleConfirmMoveServer = () => {
  if (!movingServer.value?.id) return;

  serverStore.assignServerToGroup(
    movingServer.value.id,
    movingTargetGroupId.value === "__ungrouped__" ? null : movingTargetGroupId.value
  );
  showMoveServerDialog.value = false;
  movingServer.value = null;
  ElMessage.success(t('success.saved'));
};

// 版本号点击处理
const handleVersionClick = async () => {
  if (appStore.updateInfo?.hasUpdate) {
    try {
      await ElMessageBox.confirm(
        t('sidebar.update.confirmDownload', { version: appStore.updateInfo.latestVersion }),
        t('sidebar.update.newVersionFound'),
        {
          confirmButtonText: t('sidebar.update.installNow'),
          cancelButtonText: t('common.cancel'),
          type: 'info',
        }
      );
      await appStore.installUpdate();
    } catch (e) {
      if (e !== 'cancel') {
        ElMessage.error(`${t('errors.updateInstallFailed')}: ${e}`);
      }
    }
  }
};

// ===== 订阅相关 =====
const showSubDialog = ref(false);
const subLoading = ref(false);
const isEditingSubscription = ref(false);
const editingSubscriptionId = ref<number | null>(null);
const editingOldTopic = ref("");

// 预设颜色选项
const colorOptions = [
  "#F56C6C", // 红色
  "#E6A23C", // 橙色
  "#F2D849", // 黄色
  "#67C23A", // 绿色
  "#409EFF", // 蓝色
  "#9B59B6", // 紫色
  "#FF69B4", // 粉色
  "#00CED1", // 青色
];

const subFormData = reactive({
  topic: "",
  qos: 0,
  color: "",
});

const handleAddSubscription = () => {
  subFormData.topic = "";
  subFormData.qos = 0;
  subFormData.color = "";
  isEditingSubscription.value = false;
  editingSubscriptionId.value = null;
  editingOldTopic.value = "";
  showSubDialog.value = true;
};

const handleEditSubscription = (sub: Subscription) => {
  subFormData.topic = sub.topic;
  subFormData.qos = sub.qos;
  subFormData.color = sub.color || "";
  isEditingSubscription.value = true;
  editingSubscriptionId.value = sub.id!;
  editingOldTopic.value = sub.topic;
  showSubDialog.value = true;
};

const handleDeleteSubscription = async (sub: Subscription) => {
  try {
    await ElMessageBox.confirm(t('sidebar.deleteSubscriptionConfirm', { topic: sub.topic }), t('common.confirm'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: "warning",
    });
    await subscriptionStore.removeSubscription(
      sub.id!,
      serverStore.activeServerId!,
      sub.topic
    );
    ElMessage.success(t('success.unsubscribed'));
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(`${t('errors.unsubscribeFailed')}: ${error}`);
    }
  }
};

const handleToggleSubscription = async (sub: Subscription, isActive: boolean) => {
  try {
    await subscriptionStore.toggleSubscription(
      sub.id!,
      serverStore.activeServerId!,
      sub.topic,
      sub.qos,
      isActive
    );
    ElMessage.success(t('success.saved'));
  } catch (error) {
    ElMessage.error(`${t('errors.subscribeFailed')}: ${error}`);
  }
};

const handleConfirmSubscription = async () => {
  if (!subFormData.topic.trim()) {
    ElMessage.warning(t('errors.inputTopic'));
    return;
  }

  const serverId = serverStore.activeServerId;
  if (!serverId) {
    ElMessage.warning(t('errors.selectServer'));
    return;
  }

  subLoading.value = true;
  try {
    if (isEditingSubscription.value && editingSubscriptionId.value) {
      // 编辑模式
      await subscriptionStore.updateSubscription(serverId, editingOldTopic.value, {
        id: editingSubscriptionId.value,
        topic: subFormData.topic,
        qos: subFormData.qos,
        color: subFormData.color || undefined,
      });
      ElMessage.success(t('success.saved'));
    } else {
      // 新增模式
      const newSub = await subscriptionStore.addSubscription(
        serverId,
        subFormData.topic,
        subFormData.qos
      );
      // 如果设置了颜色，需要再更新一次
      if (subFormData.color && newSub.id) {
        await subscriptionStore.updateSubscription(serverId, subFormData.topic, {
          id: newSub.id,
          color: subFormData.color,
        });
      }
      ElMessage.success(t('success.saved'));
    }
    showSubDialog.value = false;
  } catch (error) {
    console.error("Subscribe failed:", error);
    ElMessage.error(`${t('errors.subscribeFailed')}: ${error}`);
  } finally {
    subLoading.value = false;
  }
};
</script>

<style scoped lang="scss">
.sidebar {
  height: 100%;
  background-color: var(--sidebar-bg);
  border-right: 1px solid var(--app-border-color);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--app-border-color);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo-icon {
  width: 28px;
  height: 28px;
  color: var(--primary-color);

  svg {
    width: 100%;
    height: 100%;
  }
}

.logo-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--app-text-color);
}

.version-tag {
  font-size: 11px;
  font-weight: 400;
  color: var(--app-text-secondary);
  margin-left: 4px;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  
  &.has-update {
    color: var(--el-color-primary);
    cursor: pointer;
    
    &:hover {
      text-decoration: underline;
    }
  }
}

.update-dot {
  width: 8px;
  height: 8px;
  background-color: var(--el-color-danger);
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.1);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.section {
  margin-bottom: 8px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding: 0 4px;
}

.section-title-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  
  &:hover {
    .section-title {
      color: var(--app-text-color);
    }
  }
}

.collapse-icon {
  font-size: 12px;
  color: var(--app-text-secondary);
  transition: transform 0.2s ease;
  
  &.collapsed {
    transform: rotate(-90deg);
  }
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--app-text-secondary);
  transition: color 0.2s ease;
}

.server-list,
.subscription-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.server-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s ease;

  &:hover {
    background-color: var(--sidebar-hover);

    .group-more-btn {
      opacity: 1;
    }
  }
}

.group-header--static {
  cursor: default;

  &:hover {
    background-color: transparent;
  }
}

.group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.group-folder-icon {
  font-size: 13px;
  color: var(--app-text-secondary);
}

.group-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-secondary);
}

.group-count {
  font-size: 11px;
  color: var(--app-text-secondary);
  background: var(--sidebar-active);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 18px;
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.server-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s ease;

  &:hover {
    background-color: var(--sidebar-hover);

    .more-btn {
      opacity: 1;
    }
  }

  &.active {
    background-color: var(--sidebar-active);
  }
}

.server-item--nested {
  margin-left: 18px;
}

.server-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.server-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--app-text-color);
}

.server-host {
  font-size: 11px;
  color: var(--app-text-secondary);
}

.more-btn {
  opacity: 0;
  transition: opacity 0.2s ease;
}

.group-more-btn {
  flex-shrink: 0;
}

.collapse-icon--group {
  font-size: 11px;
}

.subscription-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--app-border-color);
  transition: all 0.2s ease;

  &:hover {
    background-color: var(--sidebar-hover);
    border-color: var(--el-color-primary-light-5);

    .sub-actions {
      opacity: 1;
    }
  }

  &.inactive {
    opacity: 0.6;
  }

  &.pending {
    border-color: var(--el-color-warning-light-5);
  }

  &.failed {
    border-color: var(--el-color-danger-light-5);
  }
}

.sub-row-1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  
  .el-switch {
    flex-shrink: 0;
    margin-left: auto;
  }
}

.sub-row-2 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.subscription-runtime {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.subscription-state-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.pending-icon {
  color: var(--el-color-warning);
  animation: subscription-spin 1s linear infinite;
}

.failed-icon {
  color: var(--el-color-danger);
}

@keyframes subscription-spin {
  to {
    transform: rotate(360deg);
  }
}

.sub-row-2-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sub-color-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sub-topic {
  font-size: 12px;
  font-family: "Fira Code", "Consolas", monospace;
  color: var(--app-text-color);
  flex: 1;
  min-width: 0;
}

.sub-actions {
  display: flex;
  gap: 0;
  opacity: 0;
  transition: opacity 0.2s ease;
  
  .el-button {
    padding: 4px;
  }
}

.empty-state {
  padding: 16px 0;
}

.empty-hint {
  text-align: center;
  padding: 12px;
  font-size: 12px;
  color: var(--app-text-secondary);
}

.sidebar-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--app-border-color);
}

.theme-btn {
  width: 100%;
  justify-content: flex-start;
}

:deep(.el-divider) {
  margin: 8px 0;
}

.color-picker-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.color-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.color-option {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    transform: scale(1.1);
  }

  &.active {
    border-color: var(--app-text-color);
    box-shadow: 0 0 0 2px var(--sidebar-bg);
  }

  &.no-color {
    background-color: var(--sidebar-bg);
    border: 1px dashed var(--app-border-color);
    
    .el-icon {
      font-size: 12px;
      color: var(--app-text-secondary);
    }
  }
}

.move-server-name {
  color: var(--app-text-color);
  font-weight: 500;
}
</style>
