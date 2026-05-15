<template>
  <div ref="mainContentRef" class="main-content" :class="{ resizing: isResizing }">
    <!-- 消息列表 -->
    <MessageList class="message-list" />

    <div class="panel-resizer" @mousedown="handleResizeStart" />

    <!-- 发布消息 -->
    <PublishPanel
      class="publish-panel"
      :style="{ height: `${publishPanelHeight}px` }"
      :scheduled-publish-running="scheduledPublishRunning"
      :timed-message-running="timedMessageRunning"
      @save-template="handleSaveTemplate"
      @open-templates="handleOpenTemplates"
      @scheduled-publish="handleScheduledPublish"
      @update:timed-message-running="handleTimedMessageRunningChange"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import MessageList from "./MessageList.vue";
import PublishPanel from "./PublishPanel.vue";

interface SaveTemplateData {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  payloadType: string;
}

defineProps<{
  scheduledPublishRunning: boolean;
  timedMessageRunning: boolean;
}>();

const mainContentRef = ref<HTMLElement | null>(null);
const isResizing = ref(false);
const publishPanelHeight = ref(220);

const MIN_MESSAGE_LIST_HEIGHT = 180;
const MIN_PUBLISH_PANEL_HEIGHT = 200;
const RESIZER_HEIGHT = 10;
const RESIZER_MARGIN = 6;

let resizeStartY = 0;
let resizeStartPublishHeight = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getMaxPublishHeight(): number {
  const container = mainContentRef.value;
  if (!container) return publishPanelHeight.value;

  const styles = window.getComputedStyle(container);
  const verticalPadding =
    parseFloat(styles.paddingTop || "0") + parseFloat(styles.paddingBottom || "0");
  const availableHeight = container.clientHeight - verticalPadding;
  const resizerOccupiedHeight = RESIZER_HEIGHT + RESIZER_MARGIN * 2;

  return Math.max(
    MIN_PUBLISH_PANEL_HEIGHT,
    availableHeight - MIN_MESSAGE_LIST_HEIGHT - resizerOccupiedHeight
  );
}

function normalizePublishPanelHeight(): void {
  publishPanelHeight.value = clamp(
    publishPanelHeight.value,
    MIN_PUBLISH_PANEL_HEIGHT,
    getMaxPublishHeight()
  );
}

function handleResizeMove(event: MouseEvent): void {
  if (!isResizing.value) return;
  const deltaY = event.clientY - resizeStartY;
  const nextHeight = resizeStartPublishHeight - deltaY;
  publishPanelHeight.value = clamp(
    nextHeight,
    MIN_PUBLISH_PANEL_HEIGHT,
    getMaxPublishHeight()
  );
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
  resizeStartY = event.clientY;
  resizeStartPublishHeight = publishPanelHeight.value;
  isResizing.value = true;
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", handleResizeMove);
  window.addEventListener("mouseup", stopResize);
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
  normalizePublishPanelHeight();
  window.addEventListener("resize", normalizePublishPanelHeight);
});

onBeforeUnmount(() => {
  stopResize();
  window.removeEventListener("resize", normalizePublishPanelHeight);
});
</script>

<style scoped lang="scss">
.main-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 16px;
  overflow: hidden;
}

.message-list {
  flex: 1;
  min-height: 180px;
}

.panel-resizer {
  height: 10px;
  margin: 6px 0;
  border-radius: 6px;
  cursor: row-resize;
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
    width: 44px;
    height: 3px;
    border-radius: 999px;
    background-color: var(--app-border-color);
  }

  &:hover {
    background-color: var(--sidebar-hover);
  }
}

.publish-panel {
  flex-shrink: 0;
  min-height: 200px;
}

.main-content.resizing .panel-resizer {
  background-color: var(--sidebar-hover);
}
</style>
