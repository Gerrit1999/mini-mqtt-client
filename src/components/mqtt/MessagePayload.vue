<template>
  <div class="message-payload" :class="{ preview, expanded: !preview, 'full-preview': isFormattedJsonPreview }">
    <!-- JSON 格式 -->
    <div v-if="effectiveFormat === 'json'" class="payload-content json-content">
      <pre
        v-if="shouldHighlight"
        v-html="highlightText(preview ? previewDisplayPayload : detailDisplayPayload)"
      />
      <pre v-else>{{ preview ? previewDisplayPayload : detailDisplayPayload }}</pre>
    </div>

    <!-- 二进制/HEX 格式 -->
    <div v-else-if="effectiveFormat === 'hex'" class="payload-content hex-content">
      <!-- 预览模式：只显示简单的 HEX 字符串 -->
      <div v-if="preview" class="hex-preview-simple">
        <span v-if="shouldHighlight" v-html="highlightText(simpleHexPreview)" />
        <span v-else>{{ simpleHexPreview }}</span>
      </div>
      <!-- 详情模式：显示完整的 HEX + ASCII 展示 -->
      <div v-else class="hex-display">
        <div class="hex-row" v-for="(row, index) in hexRows" :key="index">
          <span class="offset">{{ formatOffset(index * 16) }}</span>
          <span class="hex-bytes">
            <span
              v-for="(byte, i) in row.bytes"
              :key="i"
              class="byte"
              :class="{ separator: i === 7 }"
            >{{ byte }}</span>
          </span>
          <span class="ascii">{{ row.ascii }}</span>
        </div>
      </div>
    </div>

    <!-- Base64 格式 -->
    <div v-else-if="effectiveFormat === 'base64'" class="payload-content base64-content">
      <pre v-if="shouldHighlight" v-html="highlightText(base64Payload)" />
      <pre v-else>{{ base64Payload }}</pre>
    </div>

    <!-- 纯文本格式 -->
    <div v-else class="payload-content text-content">
      <pre
        v-if="shouldHighlight"
        v-html="highlightText(preview ? previewDisplayPayload : detailDisplayPayload)"
      />
      <pre v-else>{{ preview ? previewDisplayPayload : detailDisplayPayload }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { parse as parseLosslessJson, stringify as stringifyLosslessJson } from "lossless-json";
import { computed } from "vue";
import type { PayloadFormat } from "@/types/mqtt";
import { detectPayloadFormat, encodePayload } from "@/utils/payloadCodec";

const props = defineProps<{
  payload: string | Uint8Array | undefined;
  preview?: boolean;
  payloadType?: PayloadFormat;
  formatJson?: boolean;
  highlightKeyword?: string;
  searchMatchCase?: boolean;
  searchWholeWord?: boolean;
  searchUseRegex?: boolean;
}>();

const shouldHighlight = computed(() => Boolean(props.highlightKeyword?.trim()));

// 将 payload 转换为字符串
const payloadString = computed(() => {
  if (!props.payload) return "";
  return typeof props.payload === "string"
    ? props.payload
    : new TextDecoder().decode(props.payload);
});

// 将 payload 转换为字节数组
const payloadBytes = computed(() => {
  if (!props.payload) return new Uint8Array();
  return typeof props.payload === "string"
    ? new TextEncoder().encode(props.payload)
    : props.payload;
});

// 自动检测格式
const detectedFormat = computed<PayloadFormat>(() => {
  return detectPayloadFormat(payloadBytes.value);
});

// 有效格式（优先使用指定的 payloadType，否则使用自动检测）
const effectiveFormat = computed<PayloadFormat>(() => {
  return props.payloadType ?? detectedFormat.value;
});

const base64Payload = computed(() => encodePayload(payloadBytes.value, "base64"));

// 简单的 HEX 预览（用于列表预览，不包含 offset 和 ASCII）
const simpleHexPreview = computed(() => {
  const bytes = payloadBytes.value;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
});

// JSON 格式化（失败时回退原始文本，避免破坏现有行为）
const formattedJsonPayload = computed(() => {
  if (!props.formatJson || effectiveFormat.value !== "json") {
    return payloadString.value;
  }
  try {
    const parsed = parseLosslessJson(payloadString.value, undefined, {
      // Match JSON.parse behavior when object keys are repeated.
      onDuplicateKey: ({ newValue }) => newValue,
    });
    return stringifyLosslessJson(parsed, undefined, 2) ?? payloadString.value;
  } catch {
    return payloadString.value;
  }
});

// 显示的 payload（用于预览或文本显示）
const displayPayload = computed(() => {
  return formattedJsonPayload.value;
});

const isFormattedJsonPreview = computed(
  () => Boolean(props.preview) && effectiveFormat.value === "json" && Boolean(props.formatJson)
);

const previewDisplayPayload = computed(() => {
  return displayPayload.value;
});

// 带换行符标记的 payload（用于详情展示）
const detailDisplayPayload = computed(() => {
  const str = displayPayload.value;
  // 在换行符前添加 ↵ 符号标记原始换行位置
  return str.replace(/\r?\n/g, '↵$&');
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

function highlightText(text: string): string {
  const source = String(text ?? "");
  const keyword = props.highlightKeyword?.trim() ?? "";
  const regex = buildSearchRegex(keyword, {
    matchCase: Boolean(props.searchMatchCase),
    wholeWord: Boolean(props.searchWholeWord),
    useRegex: Boolean(props.searchUseRegex),
  });
  if (!keyword || !regex) return escapeHtml(source);

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

    if (match[0].length === 0) {
      globalRegex.lastIndex++;
    }
  }

  highlighted += escapeHtml(source.slice(lastIndex));
  return highlighted;
}

// HEX 行数据
const hexRows = computed(() => {
  const bytes = payloadBytes.value;
  const rows: { bytes: string[]; ascii: string }[] = [];

  for (let i = 0; i < bytes.length; i += 16) {
    const rowBytes = Array.from(bytes.slice(i, i + 16));
    const hexBytes = rowBytes.map((b) =>
      b.toString(16).padStart(2, "0").toUpperCase()
    );

    // 填充到 16 字节
    while (hexBytes.length < 16) {
      hexBytes.push("  ");
    }

    const ascii = rowBytes
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
      .join("");

    rows.push({ bytes: hexBytes, ascii });
  }

  return rows;
});

// 格式化偏移量
function formatOffset(offset: number) {
  return offset.toString(16).toUpperCase().padStart(8, "0");
}

// 暴露格式类型供外部使用
defineExpose({
  detectedFormat,
  effectiveFormat,
});
</script>

<style scoped lang="scss">
.message-payload {
  font-family: "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.45;
}

.message-payload.preview {
  .payload-content {
    max-height: 100%;
    overflow: hidden;
  }

  pre,
  .hex-preview-simple {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
}

.message-payload.preview.full-preview {
  .payload-content {
    overflow: visible;
  }

  pre {
    display: block;
    overflow: visible;
    -webkit-line-clamp: unset;
  }
}

.message-payload.expanded {
  .payload-content {
    max-height: 400px;
    overflow-y: auto;
  }
}

.payload-content {
  padding: 4px 6px;
  background-color: var(--sidebar-bg);
  border: 1px solid var(--app-border-color);
  border-radius: 6px;

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.json-content {
  pre {
    color: var(--msg-publish);
  }
}

.hex-content {
  .hex-preview {
    color: var(--app-text-secondary);
    font-size: 12px;
  }
  
  .hex-preview-simple {
    color: var(--msg-publish);
    font-size: 12px;
    word-break: break-all;
  }
}

.hex-display {
  overflow-x: auto;
}

.hex-row {
  display: flex;
  gap: 12px;
  white-space: nowrap;

  &:hover {
    background-color: var(--sidebar-hover);
  }
}

.offset {
  color: var(--app-text-secondary);
  min-width: 72px;
  user-select: none;
}

.hex-bytes {
  color: var(--msg-publish);
  display: flex;
  gap: 4px;

  .byte {
    min-width: 18px;
    text-align: center;

    &.separator {
      margin-right: 8px;
    }
  }
}

.ascii {
  color: var(--status-connected);
  min-width: 140px;
  padding-left: 12px;
  border-left: 1px solid var(--app-border-color);
}

.text-content {
  pre {
    color: var(--app-text-color);
  }
}

.base64-content {
  pre {
    color: var(--msg-publish);
  }
}

:deep(mark.search-highlight) {
  background: rgba(250, 204, 21, 0.35);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.raw-text {
  color: var(--app-text-secondary);
}
</style>
