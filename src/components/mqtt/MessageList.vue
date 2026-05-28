<template>
  <div class="message-list app-card">
    <div class="panel-header">
      <span class="panel-title">
        <el-icon><ChatDotRound /></el-icon>
        {{ $t('messages.title') }}
        <el-tag
          size="small"
          type="info"
          effect="plain"
          v-if="messages.length > 0 || receivedCount > 0"
          :title="$t('messages.countSummary')"
        >
          {{ messages.length }} / {{ receivedCount }}
        </el-tag>
      </span>
      <div class="header-actions">
        <el-select
          v-model="selectedTopics"
          :placeholder="$t('publish.topic')"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          size="small"
          style="width: 140px"
        >
          <el-option
            v-for="topic in topics"
            :key="topic"
            :label="topic"
            :value="topic"
          />
        </el-select>
        <el-input
          v-model="searchKeyword"
          :class="{ 'is-invalid-regex': isRegexInvalid }"
          :placeholder="$t('template.searchPlaceholder')"
          :prefix-icon="Search"
          size="small"
          style="width: 160px"
          clearable
          :title="isRegexInvalid ? t('messages.search.invalidRegex') : ''"
        />
        <el-popover placement="bottom" trigger="click" :width="220">
          <template #reference>
            <el-button size="small">.*</el-button>
          </template>
          <div class="search-options">
            <el-checkbox v-model="searchMatchCase">{{ t('messages.search.matchCase') }}</el-checkbox>
            <el-checkbox v-model="searchWholeWord">{{ t('messages.search.wholeWord') }}</el-checkbox>
            <el-checkbox v-model="searchUseRegex">{{ t('messages.search.useRegex') }}</el-checkbox>
          </div>
        </el-popover>
        <el-dropdown @command="handleFilterCommand">
          <el-button size="small">
            {{ filterLabel }}
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="all">{{ $t('template.allCategories') }}</el-dropdown-item>
              <el-dropdown-item command="publish">{{ $t('messages.direction.sent') }}</el-dropdown-item>
              <el-dropdown-item command="receive">{{ $t('messages.direction.received') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <div class="format-toggle">
          <span class="format-toggle-label">{{ $t('messages.formatJson') }}</span>
          <el-switch v-model="formatJsonPayload" size="small" />
        </div>
        <el-divider direction="vertical" />
        <el-tooltip :content="$t('messages.autoScroll')" placement="top">
          <el-button
            text
            size="small"
            :icon="Bottom"
            :type="appStore.autoScroll ? 'primary' : 'default'"
            @click="appStore.setAutoScroll(!appStore.autoScroll)"
          />
        </el-tooltip>
        <el-divider direction="vertical" />
        <el-tooltip :content="$t('messages.clear')" placement="top">
          <el-button text size="small" :icon="Delete" @click="handleClear" />
        </el-tooltip>
        <el-dropdown trigger="click" @command="handleExportCommand">
          <el-button text size="small" :icon="Download" :title="$t('messages.export')" />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="json">JSON</el-dropdown-item>
              <el-dropdown-item command="csv">CSV</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="message-scroll-wrapper" ref="listViewport">
      <div v-if="showLoadMore" class="load-more-row">
        <el-button
          size="small"
          text
          :loading="messageStore.loadingMore"
          :disabled="messageStore.loading || messageStore.loadingMore"
          @click="handleLoadMore"
        >
          {{ messageStore.loading ? $t('messages.loadingHistory') : $t('messages.loadMore') }}
        </el-button>
      </div>

      <div v-if="filteredMessages.length === 0" class="empty-state">
        <el-empty :description="$t('messages.noMessages')" :image-size="60">
        </el-empty>
      </div>

      <FixedSizeList
        v-else
        ref="virtualListRef"
        class-name="message-virtual-window"
        :data="filteredMessages"
        :total="filteredMessages.length"
        :height="virtualListHeight"
        :item-size="MESSAGE_ITEM_HEIGHT"
      >
        <template #default="{ data, index, style }">
          <div :style="style" class="message-row">
            <div
              v-for="msg in [data[index]]"
              :key="msg.seq ?? msg.id ?? msg.timestamp"
              class="message-item"
              :class="[msg.direction, { 'has-error': msg.scriptError }]"
              @click="showDetail(msg)"
            >
              <div class="message-header">
                <span class="msg-direction" :class="[msg.direction, { 'has-error': msg.scriptError }]">
                  <el-icon v-if="msg.direction === 'publish'"><Top /></el-icon>
                  <el-icon v-else><Bottom /></el-icon>
                  {{ msg.direction === "publish" ? "PUB" : "RCV" }}
                </span>
                <span
                  class="msg-topic text-ellipsis"
                  :style="getTopicColor(msg) ? { color: getTopicColor(msg) } : {}"
                >
                  <span v-if="getTopicColor(msg)" class="topic-color-dot" :style="{ backgroundColor: getTopicColor(msg) }" />
                  <span class="topic-text" v-html="highlightText(msg.topic)" />
                </span>
                <div class="msg-meta">
                  <el-tag
                    v-if="msg.scriptError"
                    size="small"
                    effect="plain"
                    type="danger"
                    class="error-tag"
                  >
                    {{ $t('script.testError') }}
                  </el-tag>
                  <el-tag
                    size="small"
                    effect="plain"
                    :type="getFormatTagType(getMessageFormat(msg))"
                    class="format-tag"
                  >
                    {{ getFormatLabel(getMessageFormat(msg), msg) }}
                  </el-tag>
                  <el-tag size="small" effect="plain">Q{{ msg.qos }}</el-tag>
                  <el-tag v-if="msg.retain" size="small" type="warning" effect="plain">
                    R
                  </el-tag>
                  <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
                </div>
              </div>
              <div v-if="msg.scriptError" class="message-error">
                <el-icon><WarningFilled /></el-icon>
                <span>{{ msg.scriptError }}</span>
              </div>
              <div class="message-body">
                <MessagePayload
                  :payload="msg.payload"
                  :preview="true"
                  :payload-type="msg.payload_type"
                  :format-json="formatJsonPayload"
                  :highlight-keyword="searchKeyword.trim()"
                  :search-match-case="searchMatchCase"
                  :search-whole-word="searchWholeWord"
                  :search-use-regex="searchUseRegex"
                />
              </div>
            </div>
          </div>
        </template>
      </FixedSizeList>
    </div>

    <!-- 消息详情对话框 -->
    <el-dialog
      v-model="showDetailDialog"
      :title="selectedMessage?.topic || $t('messages.viewPayload')"
      width="700px"
      class="message-detail-dialog"
    >
      <div v-if="selectedMessage" class="message-detail">
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item :label="$t('messages.direction.sent')">
            <span class="msg-direction" :class="selectedMessage.direction">
              {{ selectedMessage.direction === "publish" ? $t('messages.direction.sent') : $t('messages.direction.received') }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item :label="$t('publish.qos')">
            {{ selectedMessage.qos }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('publish.retain')">
            {{ selectedMessage.retain ? "Yes" : "No" }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('publish.payloadType')">
            <el-tag
              size="small"
              :type="getFormatTagType(getMessageFormat(selectedMessage))"
            >
              {{ getFormatLabel(getMessageFormat(selectedMessage), selectedMessage) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="Time" :span="2">
            {{ formatFullTime(selectedMessage.timestamp) }}
          </el-descriptions-item>
          <el-descriptions-item :label="$t('publish.topic')" :span="3">
            <code class="topic-code">{{ selectedMessage.topic }}</code>
          </el-descriptions-item>
        </el-descriptions>

        <div class="payload-section">
          <div class="payload-header">
            <span class="section-title">{{ $t('publish.payload') }}</span>
            <div class="payload-actions">
              <el-button size="small" text :icon="CopyDocument" @click="copyPayload">
                {{ $t('messages.copyPayload') }}
              </el-button>
              <el-button
                size="small"
                text
                :icon="Promotion"
                @click="copyToPublish"
              >
                {{ $t('messages.copyToPublish') }}
              </el-button>
            </div>
          </div>
          <MessagePayload
            :payload="selectedMessage.payload"
            :preview="false"
            :payload-type="selectedMessage.payload_type"
            :format-json="formatJsonPayload"
            :highlight-keyword="searchKeyword.trim()"
            :search-match-case="searchMatchCase"
            :search-whole-word="searchWholeWord"
            :search-use-regex="searchUseRegex"
          />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ChatDotRound,
  Delete,
  Download,
  Top,
  Bottom,
  ArrowDown,
  Search,
  CopyDocument,
  Promotion,
  WarningFilled,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox, FixedSizeList } from "element-plus";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useServerStore } from "@/stores/server";
import { useMqttStore } from "@/stores/mqtt";
import { useMessageStore } from "@/stores/message";
import { useAppStore } from "@/stores/app";
import { useSubscriptionStore } from "@/stores/subscription";
import MessagePayload from "./MessagePayload.vue";
import type { MessageHistory, MqttMessage } from "@/types/mqtt";

const { t } = useI18n();

type PayloadFormat = "json" | "binary" | "text";
type DirectionFilter = "all" | "publish" | "receive";
type ExportFormat = "json" | "csv";
interface DerivedMessageMeta {
  key: string;
  payloadText: string;
  payloadHex?: string;
  format: PayloadFormat;
  timestampValue: number;
}

const serverStore = useServerStore();
const mqttStore = useMqttStore();
const messageStore = useMessageStore();
const appStore = useAppStore();
const subscriptionStore = useSubscriptionStore();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const derivedMessageCache = new WeakMap<MqttMessage, DerivedMessageMeta>();

const listViewport = ref<HTMLElement>();
const virtualListRef = ref<any>();
const HISTORY_PAGE_SIZE = 200;
const MESSAGE_ITEM_HEIGHT = 148;
const LOAD_MORE_ROW_HEIGHT = 42;
const virtualListHeight = ref(MESSAGE_ITEM_HEIGHT * 2);
let viewportResizeObserver: ResizeObserver | null = null;

function resolveElement(target: unknown): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (
    typeof target === "object" &&
    target !== null &&
    "value" in target &&
    (target as { value?: unknown }).value instanceof HTMLElement
  ) {
    return (target as { value: HTMLElement }).value;
  }
  return null;
}

function getScrollWindow(): HTMLElement | null {
  return resolveElement(virtualListRef.value?.windowRef);
}

function syncVirtualListHeight() {
  const viewport = listViewport.value;
  if (!viewport) return;

  const availableHeight =
    viewport.clientHeight - (showLoadMore.value ? LOAD_MORE_ROW_HEIGHT : 0);
  virtualListHeight.value = Math.max(MESSAGE_ITEM_HEIGHT, availableHeight);
}

function scrollToBottom() {
  const total = filteredMessages.value.length;
  if (total > 0) {
    virtualListRef.value?.scrollToItem(total - 1);
    return;
  }

  const el = getScrollWindow();
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

// 自动滚动到底部（监听 mqtt.ts 派发的原生事件，确保在 DOM 更新后触发）
function handleMessagesFlushed(event: Event) {
  const customEvent = event as CustomEvent<{ serverIds: number[] }>;
  const serverId = serverStore.activeServerId;
  if (!serverId) return;
  if (!customEvent.detail.serverIds.includes(serverId)) return;

  nextTick(() => {
    if (!appStore.autoScroll) return;
    scrollToBottom();
  });
}

onMounted(() => {
  window.addEventListener("mqtt-messages-flushed", handleMessagesFlushed);
  viewportResizeObserver = new ResizeObserver(() => {
    syncVirtualListHeight();
  });
  if (listViewport.value) {
    viewportResizeObserver.observe(listViewport.value);
  }
  nextTick(() => {
    syncVirtualListHeight();
  });
});

onUnmounted(() => {
  window.removeEventListener("mqtt-messages-flushed", handleMessagesFlushed);
  viewportResizeObserver?.disconnect();
  viewportResizeObserver = null;
});

// 获取消息的 topic 颜色
function getTopicColor(msg: MqttMessage): string | undefined {
  const serverId = serverStore.activeServerId;
  if (!serverId) return undefined;
  
  // 只有接收的消息才显示订阅颜色
  if (msg.direction !== "receive") return undefined;
  
  const subscription = subscriptionStore.getSubscriptionByTopic(serverId, msg.topic);
  return subscription?.color;
}
const searchKeyword = ref("");
const searchMatchCase = ref(false);
const searchWholeWord = ref(false);
const searchUseRegex = ref(false);
const directionFilter = ref<DirectionFilter>("all");
const selectedTopics = ref<string[]>([]);
const formatJsonPayload = ref(false);
const showDetailDialog = ref(false);
const selectedMessage = ref<MqttMessage | null>(null);

function mapPayloadType(
  payloadFormat?: MessageHistory["payload_format"]
): MqttMessage["payload_type"] | undefined {
  if (payloadFormat === "json" || payloadFormat === "hex" || payloadFormat === "text") {
    return payloadFormat;
  }
  return undefined;
}

function historyPayloadToBytes(
  payload?: string,
  payloadFormat?: MessageHistory["payload_format"]
): Uint8Array | undefined {
  if (payload === undefined) return undefined;
  if (payloadFormat !== "hex") {
    return textEncoder.encode(payload);
  }

  const cleanHex = payload.replace(/\s/g, "");
  if (cleanHex.length === 0 || cleanHex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleanHex)) {
    return textEncoder.encode(payload);
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

function historyToRealtimeMessage(message: MessageHistory): MqttMessage {
  return {
    id: message.id,
    server_id: message.server_id,
    direction: message.direction as "publish" | "receive",
    topic: message.topic,
    payload: historyPayloadToBytes(message.payload, message.payload_format),
    qos: message.qos as 0 | 1 | 2,
    retain: message.retain,
    timestamp: message.created_at,
    payload_type: mapPayloadType(message.payload_format),
  };
}

function getMessageKey(msg: MqttMessage): string {
  if (msg.id !== undefined) return `id:${msg.id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  return `fallback:${msg.direction}:${msg.topic}:${msg.timestamp ?? ""}:${msg.qos}:${msg.retain}`;
}

function payloadToBytes(payload: string | Uint8Array | undefined): Uint8Array {
  if (!payload) return new Uint8Array();
  if (payload instanceof Uint8Array) return payload;
  return textEncoder.encode(payload);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function buildDerivedMessageMeta(msg: MqttMessage): DerivedMessageMeta {
  const payloadBytes = payloadToBytes(msg.payload);
  const payloadText =
    msg.payload instanceof Uint8Array ? textDecoder.decode(msg.payload) : String(msg.payload ?? "");

  let format: PayloadFormat;
  if (msg.payload_type === "hex") {
    format = "binary";
  } else if (msg.payload_type === "json") {
    format = "json";
  } else if (msg.payload_type === "text") {
    format = "text";
  } else {
    format = detectPayloadFormat(payloadText, payloadBytes);
  }

  return {
    key: getMessageKey(msg),
    payloadText,
    format,
    timestampValue: msg.timestamp ? Date.parse(msg.timestamp) : NaN,
  };
}

function getDerivedMessageMeta(msg: MqttMessage): DerivedMessageMeta {
  const cached = derivedMessageCache.get(msg);
  if (cached) return cached;

  const meta = buildDerivedMessageMeta(msg);
  derivedMessageCache.set(msg, meta);
  return meta;
}

function getDerivedPayloadHex(msg: MqttMessage): string {
  const meta = getDerivedMessageMeta(msg);
  if (meta.payloadHex !== undefined) {
    return meta.payloadHex;
  }

  meta.payloadHex = bytesToHex(payloadToBytes(msg.payload));
  return meta.payloadHex;
}

function compareMessages(a: MqttMessage, b: MqttMessage): number {
  const timeA = getDerivedMessageMeta(a).timestampValue;
  const timeB = getDerivedMessageMeta(b).timestampValue;

  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
    return timeA - timeB;
  }

  const seqA = a.seq ?? Number.MAX_SAFE_INTEGER;
  const seqB = b.seq ?? Number.MAX_SAFE_INTEGER;
  if (seqA !== seqB) {
    return seqA - seqB;
  }

  const idA = a.id ?? Number.MAX_SAFE_INTEGER;
  const idB = b.id ?? Number.MAX_SAFE_INTEGER;
  return idA - idB;
}

const historyMessages = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return [];
  return messageStore.getMessages(serverId).map(historyToRealtimeMessage);
});

const hasMoreHistory = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return false;
  return messageStore.getHasMoreHistory(serverId);
});

const showLoadMore = computed(
  () => messageStore.loading || messageStore.loadingMore || hasMoreHistory.value
);

const receivedCount = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return 0;
  return mqttStore.getReceivedCount(serverId);
});

function mergeMessages(history: MqttMessage[], realtime: MqttMessage[]): MqttMessage[] {
  const mergedMap = new Map<string, MqttMessage>();
  for (const msg of history) {
    mergedMap.set(getDerivedMessageMeta(msg).key, msg);
  }
  for (const msg of realtime) {
    mergedMap.set(getDerivedMessageMeta(msg).key, msg);
  }

  return Array.from(mergedMap.values()).sort(compareMessages);
}

// 从历史 + 实时流合并消息
const messages = computed(() => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return [];
  return mergeMessages(historyMessages.value, mqttStore.getServerMessages(serverId));
});

// 从消息中提取所有唯一 Topic 并排序
const topics = computed(() => {
  const uniqueTopics = new Set<string>();
  for (const msg of messages.value) {
    if (msg.topic) {
      uniqueTopics.add(msg.topic);
    }
  }
  return Array.from(uniqueTopics).sort();
});

const selectedTopicSet = computed(() => new Set(selectedTopics.value));
const trimmedSearchKeyword = computed(() => searchKeyword.value.trim());

function applyMessageFilters(source: MqttMessage[]): MqttMessage[] {
  let result = source;

  // 方向过滤
  if (directionFilter.value !== "all") {
    result = result.filter((m) => m.direction === directionFilter.value);
  }

  // Topic 多选筛选
  if (selectedTopicSet.value.size > 0) {
    result = result.filter((m) => selectedTopicSet.value.has(m.topic));
  }

  // 关键词搜索
  if (trimmedSearchKeyword.value) {
    const regex = searchRegex.value;
    if (!regex) return [];

    result = result.filter((m) => {
      const meta = getDerivedMessageMeta(m);
      return (
        matchesSearchField(m.topic, regex) ||
        matchesSearchField(meta.payloadText, regex) ||
        matchesSearchField(getDerivedPayloadHex(m), regex)
      );
    });
  }

  return result;
}

// 过滤后的消息
const filteredMessages = computed(() => applyMessageFilters(messages.value));

// 过滤标签
const filterLabel = computed(() => {
  switch (directionFilter.value) {
    case "all":
      return t('template.allCategories');
    case "publish":
      return t('messages.direction.sent');
    case "receive":
      return t('messages.direction.received');
    default:
      return t('template.allCategories');
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    const htmlEscapeMap: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return htmlEscapeMap[char];
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegex(
  keyword: string,
  options: { matchCase: boolean; wholeWord: boolean; useRegex: boolean }
): RegExp | null {
  if (!keyword) return null;

  let pattern = options.useRegex ? keyword : escapeRegExp(keyword);
  if (options.wholeWord) {
    pattern = `\\b(?:${pattern})\\b`;
  }

  const flags = options.matchCase ? "g" : "gi";

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

const searchRegex = computed(() =>
  buildSearchRegex(trimmedSearchKeyword.value, {
    matchCase: searchMatchCase.value,
    wholeWord: searchWholeWord.value,
    useRegex: searchUseRegex.value,
  })
);

const isRegexInvalid = computed(
  () =>
    Boolean(trimmedSearchKeyword.value) &&
    searchUseRegex.value &&
    !searchRegex.value
);

function matchesSearchField(value: string, regex: RegExp): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

function highlightText(text: string): string {
  const source = String(text ?? "");
  const regex = searchRegex.value;
  if (!trimmedSearchKeyword.value || !regex) return escapeHtml(source);

  const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let highlighted = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = globalRegex.exec(source)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    highlighted += escapeHtml(source.slice(lastIndex, start));
    highlighted += `<mark class="search-highlight">${escapeHtml(source.slice(start, end))}</mark>`;
    lastIndex = end;

    // 防止零宽匹配导致死循环
    if (match[0].length === 0) {
      globalRegex.lastIndex++;
    }
  }

  highlighted += escapeHtml(source.slice(lastIndex));
  return highlighted;
}

// 检测 payload 格式（自动检测，用于接收的消息）
function detectPayloadFormat(
  payload: string | Uint8Array | undefined,
  bytesArg?: Uint8Array
): PayloadFormat {
  if (!payload) return "text";

  const str = typeof payload === "string" ? payload : textDecoder.decode(payload);
  const bytes = bytesArg ?? payloadToBytes(payload);

  // 尝试检测 JSON
  if (str.trim()) {
    const trimmed = str.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        JSON.parse(trimmed);
        return "json";
      } catch {
        // 不是有效的 JSON
      }
    }
  }

  // 检测二进制数据
  if (bytes.length > 0) {
    let nonPrintableCount = 0;
    for (const byte of bytes) {
      if ((byte < 32 || byte > 126) && byte !== 9 && byte !== 10 && byte !== 13) {
        nonPrintableCount++;
      }
    }
    if (nonPrintableCount / bytes.length > 0.1) {
      return "binary";
    }
  }

  return "text";
}

// 获取消息的显示格式（优先使用保存的类型，否则自动检测）
function getMessageFormat(msg: MqttMessage): PayloadFormat {
  return getDerivedMessageMeta(msg).format;
}

// 获取格式标签类型
function getFormatTagType(
  format: PayloadFormat
): "info" | "success" | "warning" {
  const types: Record<PayloadFormat, "info" | "success" | "warning"> = {
    json: "success",
    binary: "warning",
    text: "info",
  };
  return types[format];
}

// 获取格式标签文本
function getFormatLabel(format: PayloadFormat, _msg?: MqttMessage): string {
  // binary 格式统一显示为 HEX
  const labels: Record<PayloadFormat, string> = {
    json: "JSON",
    binary: "HEX",
    text: "TEXT",
  };
  return labels[format];
}

const formatTime = (timestamp?: string) => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const locale = appStore.getDateLocale();
  const timeStr = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // 添加毫秒
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${timeStr}.${ms}`;
};

const formatFullTime = (timestamp?: string) => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const locale = appStore.getDateLocale();
  return date.toLocaleString(locale);
};

function handleFilterCommand(command: string) {
  directionFilter.value = command as DirectionFilter;
}

async function loadInitialHistory(serverId: number) {
  await messageStore.fetchMessageHistory(serverId, HISTORY_PAGE_SIZE);
  await nextTick();
  syncVirtualListHeight();

  if (appStore.autoScroll) {
    scrollToBottom();
  }
}

async function handleLoadMore() {
  const serverId = serverStore.activeServerId;
  if (!serverId) return;

  const el = getScrollWindow();
  const previousScrollHeight = el?.scrollHeight ?? 0;
  const previousScrollTop = el?.scrollTop ?? 0;

  await messageStore.loadMoreMessageHistory(serverId, HISTORY_PAGE_SIZE);
  await nextTick();
  syncVirtualListHeight();

  if (el) {
    el.scrollTop = previousScrollTop + (el.scrollHeight - previousScrollHeight);
  }
}

const handleClear = async () => {
  const serverId = serverStore.activeServerId;
  if (!serverId) return;

  try {
    await ElMessageBox.confirm(t('messages.clearConfirm'), t('messages.clearTitle'), {
      type: "warning",
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    });
    await messageStore.clearHistory(serverId);
    mqttStore.clearMessages(serverId);
    ElMessage.success(t('success.deleted'));
  } catch {
    // 用户取消
  }
};

function showDetail(message: MqttMessage) {
  selectedMessage.value = message;
  showDetailDialog.value = true;
}

function copyPayload() {
  if (selectedMessage.value) {
    const format = getMessageFormat(selectedMessage.value);
    // 二进制数据复制为 HEX 格式
    const payload = format === "binary" 
      ? getDerivedPayloadHex(selectedMessage.value)
      : getDerivedMessageMeta(selectedMessage.value).payloadText;
    navigator.clipboard.writeText(payload);
    ElMessage.success(t('success.copied'));
  }
}

function copyToPublish() {
  if (selectedMessage.value) {
    const format = getMessageFormat(selectedMessage.value);
    // 二进制数据使用 HEX 格式复制到发布面板
    const payload = format === "binary" 
      ? getDerivedPayloadHex(selectedMessage.value)
      : getDerivedMessageMeta(selectedMessage.value).payloadText;
    appStore.setCopyToPublish({
      topic: selectedMessage.value.topic,
      payload: payload,
      qos: selectedMessage.value.qos,
      retain: selectedMessage.value.retain,
      // 二进制数据设置为 hex 类型
      payloadType: format === "binary" ? "hex" : format,
    });
    ElMessage.success(t('messages.copied'));
    showDetailDialog.value = false;
  }
}

interface ExportMessageItem {
  timestamp: string;
  direction: "publish" | "receive";
  topic: string;
  qos: number;
  retain: boolean;
  payloadType: PayloadFormat;
  payloadText: string;
  payloadHex?: string;
  scriptError?: string;
}

function toExportMessage(msg: MqttMessage): ExportMessageItem {
  const meta = getDerivedMessageMeta(msg);
  const format = meta.format;
  const item: ExportMessageItem = {
    timestamp: msg.timestamp ?? "",
    direction: msg.direction,
    topic: msg.topic,
    qos: msg.qos,
    retain: msg.retain,
    payloadType: format,
    payloadText: meta.payloadText,
    scriptError: msg.scriptError,
  };
  if (format === "binary") {
    item.payloadHex = getDerivedPayloadHex(msg);
  }
  return item;
}

function toCsvValue(value: string | number | boolean): string {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
}

function buildExportFileName(format: ExportFormat): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(
    2,
    "0"
  )}${String(now.getSeconds()).padStart(2, "0")}`;
  return `mqtt-messages-${stamp}.${format}`;
}

async function saveContentToFile(content: string, format: ExportFormat): Promise<string | null> {
  const defaultPath = buildExportFileName(format);
  const filePath = await save({
    defaultPath,
    filters: [
      {
        name: format.toUpperCase(),
        extensions: [format],
      },
    ],
  });

  if (!filePath) return null;
  await writeTextFile(filePath, content);
  return filePath;
}

async function exportAsJson(items: ExportMessageItem[]): Promise<string | null> {
  const payload = JSON.stringify(items, null, 2);
  return saveContentToFile(payload, "json");
}

async function exportAsCsv(items: ExportMessageItem[]): Promise<string | null> {
  const header = [
    "timestamp",
    "direction",
    "topic",
    "qos",
    "retain",
    "payloadType",
    "payloadText",
    "payloadHex",
    "scriptError",
  ].join(",");
  const rows = items.map((item) =>
    [
      toCsvValue(item.timestamp),
      toCsvValue(item.direction),
      toCsvValue(item.topic),
      toCsvValue(item.qos),
      toCsvValue(item.retain),
      toCsvValue(item.payloadType),
      toCsvValue(item.payloadText),
      toCsvValue(item.payloadHex ?? ""),
      toCsvValue(item.scriptError ?? ""),
    ].join(",")
  );
  return saveContentToFile([header, ...rows].join("\n"), "csv");
}

async function handleExportCommand(command: string): Promise<void> {
  const serverId = serverStore.activeServerId;
  if (!serverId) return;

  const format = command as ExportFormat;
  const fullHistory = await messageStore.fetchAllMessageHistory(serverId);
  const exportItems = applyMessageFilters(fullHistory.map(historyToRealtimeMessage)).map(toExportMessage);

  if (exportItems.length === 0) {
    ElMessage.warning(t("messages.exportEmpty"));
    return;
  }

  try {
    const savedPath =
      format === "csv" ? await exportAsCsv(exportItems) : await exportAsJson(exportItems);
    if (!savedPath) return;
    ElMessage.success(t("messages.exportSuccess", { count: exportItems.length, path: savedPath }));
  } catch (error) {
    ElMessage.error(`${t("errors.saveFailed")}: ${error}`);
  }
}

watch(
  () => serverStore.activeServerId,
  async (serverId) => {
    selectedMessage.value = null;
    if (!serverId) return;
    await loadInitialHistory(serverId);
  },
  { immediate: true }
);

watch(
  () => appStore.messageLimit,
  async () => {
    const serverId = serverStore.activeServerId;
    if (!serverId) return;
    await loadInitialHistory(serverId);
  }
);

watch(showLoadMore, () => {
  nextTick(() => {
    syncVirtualListHeight();
  });
});
</script>

<style scoped lang="scss">
.message-list {
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
  flex-shrink: 0;
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

.format-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.format-toggle-label {
  font-size: 12px;
  color: var(--app-text-secondary);
}

.search-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.is-invalid-regex :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset !important;
}

 .message-scroll-wrapper {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.load-more-row {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
  flex-shrink: 0;
}

:deep(.message-virtual-window) {
  min-height: 0;
  overflow-x: hidden !important;
  padding-right: 2px;
}

.message-row {
  width: 100%;
  height: 100%;
  padding: 0 8px 8px;
  box-sizing: border-box;
}

.message-item {
  padding: 10px 12px;
  border-radius: 8px;
  background-color: var(--sidebar-bg);
  border: 1px solid var(--app-border-color);
  cursor: pointer;
  transition: all 0.2s ease;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;

  &:hover {
    background-color: var(--sidebar-hover);
    transform: translateX(2px);
  }

  &.publish {
    border-left: 3px solid var(--msg-publish);
  }

  &.receive {
    border-left: 3px solid var(--msg-receive);
  }
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.msg-direction {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;

  .el-icon {
    font-size: 10px;
  }

  &.publish {
    background-color: rgba(59, 130, 246, 0.15);
    color: var(--msg-publish);
  }

  &.receive {
    background-color: rgba(34, 197, 94, 0.15);
    color: var(--msg-receive);
  }
}

.msg-topic {
  flex: 1;
  font-size: 12px;
  font-family: "Fira Code", "Consolas", monospace;
  color: var(--app-text-color);
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.topic-text {
  min-width: 0;
}

:deep(mark.search-highlight) {
  background: rgba(250, 204, 21, 0.35);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.topic-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.format-tag {
  font-size: 10px;
  padding: 0 6px;
  height: 18px;
  line-height: 18px;
}

.msg-time {
  font-size: 11px;
  color: var(--app-text-secondary);
  margin-left: 4px;
}

.message-body {
  margin-top: 6px;
  height: 64px;
  overflow: hidden;
}

.message-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-top: 6px;
  margin-bottom: 6px;
  background-color: var(--el-color-danger-light-9);
  border-radius: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
  
  .el-icon {
    flex-shrink: 0;
  }
  
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.message-item.has-error {
  border-left-color: var(--el-color-danger);
}

.msg-direction.has-error {
  background-color: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.error-tag {
  margin-right: 4px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

// 消息详情弹窗样式
.message-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.payload-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.payload-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--app-text-color);
}

.payload-actions {
  display: flex;
  gap: 8px;
}

.topic-code {
  font-family: "Fira Code", "Consolas", monospace;
  background-color: var(--sidebar-bg);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
