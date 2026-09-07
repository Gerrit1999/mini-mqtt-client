<template>
  <div
    ref="mainContentRef"
    class="main-content"
    :class="[
      `is-${contentLayout}`,
      {
        resizing: isResizing,
        'panel-size-transitioning': panelSizeTransitioning,
      },
    ]"
  >
    <!-- 消息列表 -->
    <MessageList class="message-list" />

    <div
      v-show="!publishPanelCollapsed"
      class="panel-resizer"
      @mousedown="handleResizeStart"
    />

    <!-- 发布消息 -->
    <PublishPanel
      class="publish-panel"
      :style="publishPanelStyle"
      :collapsed="publishPanelCollapsed"
      :layout="contentLayout"
      :scheduled-publish-running="scheduledPublishRunning"
      :timed-message-running="timedMessageRunning"
      @save-template="handleSaveTemplate"
      @open-templates="handleOpenTemplates"
      @scheduled-publish="handleScheduledPublish"
      @toggle-collapse="handleTogglePublishPanel"
      @update:timed-message-running="handleTimedMessageRunningChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import MessageList from "./MessageList.vue";
import PublishPanel from "./PublishPanel.vue";
import { useAppStore } from "@/stores/app";
import type { PayloadFormat } from "@/types/mqtt";

interface SaveTemplateData {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  payloadType: PayloadFormat;
}

defineProps<{
  scheduledPublishRunning: boolean;
  timedMessageRunning: boolean;
}>();

const mainContentRef = ref<HTMLElement | null>(null);
const isResizing = ref(false);
const publishPanelHeight = ref(320);
const publishPanelWidth = ref(420);
const publishPanelCollapsed = ref(false);
const panelSizeTransitioning = ref(false);
const appStore = useAppStore();
const contentLayout = computed(() => appStore.contentLayout);
const isHorizontal = computed(() => contentLayout.value === "horizontal");

const MIN_MESSAGE_LIST_HEIGHT = 120;
const MIN_MESSAGE_LIST_WIDTH = 280;
const MIN_PUBLISH_PANEL_HEIGHT = 280;
const MIN_PUBLISH_PANEL_WIDTH = 320;
const COLLAPSED_PUBLISH_PANEL_SIZE = 52;
const AUTO_COLLAPSE_DRAG_THRESHOLD = 48;
const AUTO_EXPAND_DRAG_THRESHOLD = 32;
const PANEL_SIZE_TRANSITION_DURATION = 160;
const RESIZER_SIZE = 6;
const RESIZER_MARGIN = 4;

let resizeStartPosition = 0;
let resizeStartPublishSize = 0;
let panelSizeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

const publishPanelStyle = computed<CSSProperties>(() => {
  if (isHorizontal.value) {
    const width = publishPanelCollapsed.value
      ? COLLAPSED_PUBLISH_PANEL_SIZE
      : publishPanelWidth.value;
    return {
      width: `${width}px`,
      minWidth: `${publishPanelCollapsed.value ? width : MIN_PUBLISH_PANEL_WIDTH}px`,
      height: "100%",
      minHeight: "0",
    };
  }

  const height = publishPanelCollapsed.value
    ? COLLAPSED_PUBLISH_PANEL_SIZE
    : publishPanelHeight.value;
  return {
    width: "100%",
    minWidth: "0",
    height: `${height}px`,
    minHeight: `${publishPanelCollapsed.value ? height : MIN_PUBLISH_PANEL_HEIGHT}px`,
  };
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getMaxPublishPanelSize(): number {
  const container = mainContentRef.value;
  if (!container) {
    return isHorizontal.value ? publishPanelWidth.value : publishPanelHeight.value;
  }

  const styles = window.getComputedStyle(container);
  const startPadding = parseFloat(
    isHorizontal.value ? styles.paddingLeft || "0" : styles.paddingTop || "0"
  );
  const endPadding = parseFloat(
    isHorizontal.value ? styles.paddingRight || "0" : styles.paddingBottom || "0"
  );
  const availableSize =
    (isHorizontal.value ? container.clientWidth : container.clientHeight) -
    startPadding -
    endPadding;
  const resizerOccupiedSize = RESIZER_SIZE + RESIZER_MARGIN * 2;
  const minimumPublishSize = isHorizontal.value
    ? MIN_PUBLISH_PANEL_WIDTH
    : MIN_PUBLISH_PANEL_HEIGHT;
  const minimumMessageSize = isHorizontal.value
    ? MIN_MESSAGE_LIST_WIDTH
    : MIN_MESSAGE_LIST_HEIGHT;

  return Math.max(
    minimumPublishSize,
    availableSize - minimumMessageSize - resizerOccupiedSize
  );
}

function normalizePublishPanelSize(): void {
  if (isHorizontal.value) {
    publishPanelWidth.value = clamp(
      publishPanelWidth.value,
      MIN_PUBLISH_PANEL_WIDTH,
      getMaxPublishPanelSize()
    );
    return;
  }

  publishPanelHeight.value = clamp(
    publishPanelHeight.value,
    MIN_PUBLISH_PANEL_HEIGHT,
    getMaxPublishPanelSize()
  );
}

function animatePanelSizeChange(): void {
  if (panelSizeTransitionTimer) {
    clearTimeout(panelSizeTransitionTimer);
  }
  panelSizeTransitioning.value = true;
  panelSizeTransitionTimer = setTimeout(() => {
    panelSizeTransitioning.value = false;
    panelSizeTransitionTimer = null;
  }, PANEL_SIZE_TRANSITION_DURATION);
}

function handleResizeMove(event: MouseEvent): void {
  if (!isResizing.value) return;
  const currentPosition = isHorizontal.value ? event.clientX : event.clientY;
  const nextSize = resizeStartPublishSize - (currentPosition - resizeStartPosition);
  const minimumPublishSize = isHorizontal.value
    ? MIN_PUBLISH_PANEL_WIDTH
    : MIN_PUBLISH_PANEL_HEIGHT;

  if (publishPanelCollapsed.value) {
    if (nextSize < minimumPublishSize - AUTO_EXPAND_DRAG_THRESHOLD) {
      return;
    }
    publishPanelCollapsed.value = false;
    animatePanelSizeChange();
  }

  if (nextSize <= minimumPublishSize - AUTO_COLLAPSE_DRAG_THRESHOLD) {
    publishPanelCollapsed.value = true;
    animatePanelSizeChange();
    return;
  }

  const normalizedSize = clamp(
    nextSize,
    minimumPublishSize,
    getMaxPublishPanelSize()
  );

  if (isHorizontal.value) {
    publishPanelWidth.value = normalizedSize;
  } else {
    publishPanelHeight.value = normalizedSize;
  }
}

function stopResize(): void {
  if (!isResizing.value) return;
  isResizing.value = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", handleResizeMove);
  window.removeEventListener("mouseup", stopResize);
}

function handleResizeStart(event: MouseEvent): void {
  event.preventDefault();
  resizeStartPosition = isHorizontal.value ? event.clientX : event.clientY;
  resizeStartPublishSize = isHorizontal.value
    ? publishPanelWidth.value
    : publishPanelHeight.value;
  isResizing.value = true;
  document.body.style.cursor = isHorizontal.value ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", handleResizeMove);
  window.addEventListener("mouseup", stopResize);
}

function handleTogglePublishPanel(): void {
  stopResize();
  animatePanelSizeChange();
  publishPanelCollapsed.value = !publishPanelCollapsed.value;
}

const emit = defineEmits<{
  saveTemplate: [data: SaveTemplateData]
  openTemplates: []
  scheduledPublish: []
  'update:timedMessageRunning': [value: boolean]
}>();

function handleSaveTemplate(data: SaveTemplateData) {
  emit('saveTemplate', data);
}

function handleOpenTemplates() {
  emit('openTemplates');
}

function handleScheduledPublish() {
  emit('scheduledPublish');
}

function handleTimedMessageRunningChange(value: boolean) {
  emit('update:timedMessageRunning', value);
}

onMounted(() => {
  normalizePublishPanelSize();
  window.addEventListener("resize", normalizePublishPanelSize);
});

watch(contentLayout, async () => {
  stopResize();
  await nextTick();
  normalizePublishPanelSize();
});

onBeforeUnmount(() => {
  stopResize();
  if (panelSizeTransitionTimer) {
    clearTimeout(panelSizeTransitionTimer);
  }
  window.removeEventListener("resize", normalizePublishPanelSize);
});
</script>

<style scoped lang="scss">
.main-content {
  display: flex;
  height: 100%;
  padding: 12px 16px;
  overflow: hidden;
}

.main-content.is-horizontal {
  flex-direction: row;
}

.main-content.is-vertical {
  flex-direction: column;
}

.message-list {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.is-horizontal .message-list {
  min-width: 280px;
}

.is-vertical .message-list {
  min-height: 120px;
}

.panel-resizer {
  border-radius: 6px;
  background: transparent;
  flex-shrink: 0;
  position: relative;
  transition: background-color 0.2s ease;

  &::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background-color: var(--app-border-color);
  }

  &:hover {
    background-color: var(--sidebar-hover);
  }
}

.is-horizontal .panel-resizer {
  width: 6px;
  margin: 0 4px;
  cursor: col-resize;

  &::before {
    width: 2px;
    height: 32px;
  }
}

.is-vertical .panel-resizer {
  height: 6px;
  margin: 4px 0;
  cursor: row-resize;

  &::before {
    width: 32px;
    height: 2px;
  }
}

.publish-panel {
  flex-shrink: 0;
  will-change: width, height;
}

.main-content.panel-size-transitioning .publish-panel {
  transition:
    width 160ms cubic-bezier(0.2, 0, 0, 1),
    height 160ms cubic-bezier(0.2, 0, 0, 1),
    min-width 160ms cubic-bezier(0.2, 0, 0, 1),
    min-height 160ms cubic-bezier(0.2, 0, 0, 1);
}

.main-content.resizing .panel-resizer {
  background-color: var(--sidebar-hover);
}
</style>
