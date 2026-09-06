<template>
  <div class="subscription-topic-tree">
    <el-input
      v-model="searchQuery"
      data-testid="topic-tree-search"
      class="topic-tree-search"
      size="small"
      clearable
      :prefix-icon="Search"
      :placeholder="t('sidebar.topicTree.searchPlaceholder')"
      :aria-label="t('sidebar.topicTree.searchPlaceholder')"
    />

    <el-tree
      v-loading="loading"
      class="topic-tree"
      :data="treeData"
      :props="treeProps"
      node-key="key"
      :indent="12"
      :default-expanded-keys="expandedKeys"
      :empty-text="emptyText"
    >
      <template #default="{ data }">
        <div
          class="topic-tree-node"
          :class="{ 'topic-tree-node--configured': data.subscriptions.length > 0 }"
        >
          <el-tooltip :content="nodeTooltip(data)" placement="top" :show-after="500">
            <span
              class="topic-node-label text-ellipsis"
              :class="{ 'topic-node-label--empty': data.segment === '' }"
              :title="nodeTooltip(data)"
              :data-testid="`topic-label-${data.fullPath}`"
            >
              {{ displaySegment(data.segment) }}
            </span>
          </el-tooltip>

          <div
            v-if="data.subscriptions.length > 0"
            class="topic-node-configurations"
          >
            <div
              v-for="subscription in data.subscriptions"
              :key="subscription.id ?? `${subscription.topic}-${subscription.qos}`"
              class="topic-node-configuration"
              :data-subscription-id="subscription.id"
              @click.stop
              @keydown.stop
            >
              <span
                v-if="subscription.color"
                class="subscription-color"
                :style="{ backgroundColor: subscription.color }"
                aria-hidden="true"
              />

              <el-tooltip
                :content="statusTooltip(subscription)"
                placement="top"
                :show-after="300"
              >
                <span
                  class="subscription-status"
                  :class="`subscription-status--${displayStatus(subscription)}`"
                  :title="statusTooltip(subscription)"
                  :data-testid="`subscription-status-${subscription.id}`"
                >
                  <el-icon>
                    <CircleCheck v-if="displayStatus(subscription) === 'active'" />
                    <Loading v-else-if="displayStatus(subscription) === 'pending'" />
                    <WarningFilled v-else-if="displayStatus(subscription) === 'failed'" />
                    <RemoveFilled v-else />
                  </el-icon>
                  <span>{{ statusLabel(subscription) }}</span>
                </span>
              </el-tooltip>

              <el-tag
                class="subscription-qos"
                size="small"
                effect="plain"
                :type="qosTagType(subscription)"
              >
                {{ qosLabel(subscription) }}
              </el-tag>

              <button
                type="button"
                class="subscription-toggle"
                :class="{ 'subscription-toggle--active': subscription.is_active }"
                :disabled="displayStatus(subscription) === 'pending'"
                :aria-label="toggleLabel(subscription)"
                :aria-checked="subscription.is_active"
                role="switch"
                @click="emit('toggle', subscription, !subscription.is_active)"
              >
                <span class="subscription-toggle-knob" aria-hidden="true" />
              </button>

              <el-tooltip
                v-if="displayStatus(subscription) === 'failed'"
                :content="retryLabel(subscription)"
                placement="top"
              >
                <el-button
                  class="topic-node-action"
                  text
                  size="small"
                  :icon="RefreshRight"
                  :aria-label="retryLabel(subscription)"
                  @click.stop="emit('retry', subscription)"
                />
              </el-tooltip>

              <el-dropdown
                trigger="click"
                @command="(command: string) => handleAction(command, subscription)"
              >
                <el-button
                  class="topic-node-action"
                  text
                  size="small"
                  :icon="MoreFilled"
                  :disabled="displayStatus(subscription) === 'pending'"
                  :aria-label="t('sidebar.topicTree.actions.more', { topic: subscription.topic })"
                  @click.stop
                />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="publish">
                      <el-icon><Promotion /></el-icon>
                      <span>{{ t('sidebar.topicTree.actions.publish') }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item command="edit">
                      <el-icon><Edit /></el-icon>
                      <span>{{ t('sidebar.topicTree.actions.edit') }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item command="delete" divided>
                      <el-icon><Delete /></el-icon>
                      <span>{{ t('sidebar.topicTree.actions.delete') }}</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
      </template>
    </el-tree>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  CircleCheck,
  Delete,
  Edit,
  Loading,
  MoreFilled,
  Promotion,
  RefreshRight,
  RemoveFilled,
  Search,
  WarningFilled,
} from "@element-plus/icons-vue";
import type {
  Subscription,
  SubscriptionRuntimeState,
  SubscriptionRuntimeStatus,
} from "@/types/mqtt";
import {
  buildSubscriptionTopicTree,
  collectExpandedTopicNodeKeys,
  type SubscriptionTopicTreeNode,
} from "@/utils/subscriptionTopicTree";

const props = withDefaults(
  defineProps<{
    subscriptions: Subscription[];
    runtimeStates?: ReadonlyMap<string, SubscriptionRuntimeState>;
    loading?: boolean;
  }>(),
  {
    runtimeStates: () => new Map<string, SubscriptionRuntimeState>(),
    loading: false,
  }
);

const emit = defineEmits<{
  toggle: [subscription: Subscription, isActive: boolean];
  edit: [subscription: Subscription];
  delete: [subscription: Subscription];
  retry: [subscription: Subscription];
  publish: [subscription: Subscription];
}>();

const { t } = useI18n();
const searchQuery = ref("");
const treeProps = { children: "children", label: "segment" };

const treeData = computed(() =>
  buildSubscriptionTopicTree(props.subscriptions, searchQuery.value)
);

const expandedKeys = computed(() =>
  collectExpandedTopicNodeKeys(
    treeData.value,
    searchQuery.value.trim() ? Number.POSITIVE_INFINITY : 2
  )
);

const emptyText = computed(() =>
  searchQuery.value.trim()
    ? t("sidebar.topicTree.noMatches")
    : t("sidebar.topicTree.noSubscriptions")
);

function displaySegment(segment: string): string {
  return segment === "" ? t("sidebar.topicTree.emptyLevel") : segment;
}

function nodeTooltip(node: SubscriptionTopicTreeNode): string {
  return node.subscriptions[0]?.topic ?? (node.fullPath || "/");
}

function runtimeState(
  subscription: Subscription
): SubscriptionRuntimeState | undefined {
  return props.runtimeStates.get(subscription.topic);
}

function displayStatus(subscription: Subscription): SubscriptionRuntimeStatus {
  const state = runtimeState(subscription);
  if (state?.status === "pending" || state?.status === "failed") {
    return state.status;
  }
  if (!subscription.is_active) return "disabled";
  return state?.status === "active" ? "active" : "disabled";
}

function statusLabel(subscription: Subscription): string {
  return t(`sidebar.topicTree.status.${displayStatus(subscription)}`);
}

function statusTooltip(subscription: Subscription): string {
  const label = statusLabel(subscription);
  const error = runtimeState(subscription)?.error;
  return error ? `${label}: ${error}` : label;
}

function retryLabel(subscription: Subscription): string {
  const label = t("sidebar.topicTree.actions.retry", {
    topic: subscription.topic,
  });
  const error = runtimeState(subscription)?.error;
  return error ? `${label}: ${error}` : label;
}

function qosLabel(subscription: Subscription): string {
  const state = runtimeState(subscription);
  if (state?.status !== "active" || state.granted_qos === undefined) {
    return `Q${subscription.qos}`;
  }
  return state.granted_qos === subscription.qos
    ? `Q${state.granted_qos}`
    : `Q${subscription.qos} → Q${state.granted_qos}`;
}

function qosTagType(subscription: Subscription) {
  switch (displayStatus(subscription)) {
    case "active":
      return "success";
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "info";
  }
}

function toggleLabel(subscription: Subscription): string {
  const action = subscription.is_active ? "disable" : "enable";
  return t(`sidebar.topicTree.actions.${action}`, { topic: subscription.topic });
}

function handleAction(command: string, subscription: Subscription) {
  if (command === "publish") emit("publish", subscription);
  if (command === "edit") emit("edit", subscription);
  if (command === "delete") emit("delete", subscription);
}
</script>

<style scoped lang="scss">
.subscription-topic-tree {
  min-width: 0;
}

.topic-tree-search {
  margin-bottom: 8px;
}

.topic-tree {
  background: transparent;
  color: var(--app-text-color);
}

:deep(.el-tree-node__content) {
  height: auto;
  min-height: 30px;
  padding-right: 2px;
  border-radius: 4px;
}

:deep(.el-tree-node__content:focus-within) {
  background-color: var(--sidebar-hover);
}

.topic-tree-node {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 2px 0;
}

.topic-tree-node--configured .topic-node-label {
  flex-basis: 100%;
}

.topic-node-label {
  flex: 1;
  min-width: 24px;
  font-family: "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.topic-node-label--empty {
  color: var(--app-text-secondary);
  font-style: italic;
}

.topic-node-configurations {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  width: 100%;
  min-width: 0;
}

.topic-node-configuration {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 3px;
  max-width: 100%;
}

.subscription-color {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.subscription-status {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  white-space: nowrap;

  .el-icon {
    font-size: 12px;
  }
}

.subscription-status--active {
  color: var(--el-color-success);
}

.subscription-status--pending {
  color: var(--el-color-warning);

  .el-icon {
    animation: subscription-topic-spin 1s linear infinite;
  }
}

.subscription-status--failed {
  color: var(--el-color-danger);
}

.subscription-status--disabled {
  color: var(--app-text-secondary);
}

.subscription-qos {
  height: 20px;
  padding: 0 4px;
  font-size: 10px;
}

.subscription-toggle {
  position: relative;
  width: 28px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background-color: var(--el-border-color);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.2s ease;
}

.subscription-toggle--active {
  background-color: var(--el-color-primary);
}

.subscription-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.subscription-toggle:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.subscription-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: var(--el-color-white);
  transition: transform 0.2s ease;
}

.subscription-toggle--active .subscription-toggle-knob {
  transform: translateX(12px);
}

.topic-node-action {
  width: 24px;
  height: 24px;
  padding: 4px;
}

@keyframes subscription-topic-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .subscription-status--pending .el-icon,
  .subscription-toggle,
  .subscription-toggle-knob {
    animation: none;
    transition: none;
  }
}
</style>
