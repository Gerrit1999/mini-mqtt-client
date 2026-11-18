<template>
  <div
    ref="viewport"
    class="virtual-list"
    :style="{ '--virtual-header-height': `${headerHeight}px` }"
    :role="table ? 'table' : 'list'"
    :aria-rowcount="table ? items.length + 1 : undefined"
    aria-keyshortcuts="ArrowUp ArrowDown Home End"
    tabindex="0"
    @keydown="handleKeydown"
    @focusin="handleFocus"
    @focusout="handleFocus"
  >
    <div v-if="headerHeight" class="virtual-header" :style="{ minWidth }" role="presentation">
      <slot name="header" />
    </div>
    <div v-if="items.length" class="virtual-content" :style="{ height: `${totalSize}px`, minWidth }" role="presentation">
      <div
        v-for="{ row, item } in visibleRows"
        :key="String(row.key)"
        :ref="measureRows ? measureRow : undefined"
        class="virtual-row"
        :data-index="row.index"
        :role="table ? 'row' : 'listitem'"
        :aria-rowindex="table ? row.index + 2 : undefined"
        :aria-posinset="table ? undefined : row.index + 1"
        :aria-setsize="table ? undefined : items.length"
        :style="{
          top: `${row.start - headerHeight}px`,
          height: measureRows ? undefined : `${row.size}px`,
        }"
        tabindex="-1"
      >
        <slot :item="item" :index="row.index" />
      </div>
    </div>
    <slot v-else name="empty" />
  </div>
</template>

<script setup lang="ts" generic="T extends { id?: number }">
import { computed, nextTick, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/vue-virtual'

const props = withDefaults(defineProps<{
  items: readonly T[]
  rowHeight: number
  measureRows?: boolean
  headerHeight?: number
  minWidth?: string
  table?: boolean
  resetKey?: string
}>(), { headerHeight: 0 })

const viewport = shallowRef<HTMLElement | null>(null)
const focusedRow = shallowRef<Pick<VirtualItem, 'index' | 'key'> | null>(null)
const getItemKey = computed(() => {
  const keys = props.items.map((item, index) => item.id ?? `index-${index}`)
  return (index: number) => keys[index]
})

const virtualizer = useVirtualizer(computed(() => {
  const items = props.items
  const rowHeight = props.rowHeight
  const itemKey = getItemKey.value
  const focused = focusedRow.value
  return {
    count: items.length,
    getScrollElement: () => viewport.value,
    estimateSize: () => rowHeight,
    getItemKey: itemKey,
    scrollMargin: props.headerHeight,
    scrollPaddingStart: props.headerHeight,
    overscan: 4,
    rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range)
      // Keep a focused row mounted when pointer scrolling moves it outside the window.
      if (focused && focused.index < items.length &&
          itemKey(focused.index) === focused.key &&
          !indexes.includes(focused.index)) {
        indexes.push(focused.index)
        indexes.sort((a, b) => a - b)
      }
      return indexes
    },
  }
}))

const totalSize = computed(() => virtualizer.value.getTotalSize())
const visibleRows = computed(() => virtualizer.value.getVirtualItems().flatMap(row =>
  row.index < props.items.length ? [{ row, item: props.items[row.index] }] : []
))

watch(() => props.resetKey, () => virtualizer.value.scrollToOffset(0))

function measureRow(element: Element | ComponentPublicInstance | null) {
  virtualizer.value.measureElement(element instanceof HTMLElement ? element : null)
}

function rowFor(target: EventTarget | null) {
  const row = target instanceof HTMLElement ? target.closest<HTMLElement>('.virtual-row') : null
  return row?.parentElement?.parentElement === viewport.value ? row : null
}

function handleFocus(event: FocusEvent) {
  const row = rowFor(event.type === 'focusin' ? event.target : event.relatedTarget)
  const index = row ? Number(row.dataset.index) : -1
  focusedRow.value = index >= 0 && index < props.items.length
    ? { index, key: getItemKey.value(index) }
    : null
}

async function handleKeydown(event: KeyboardEvent) {
  if (!props.items.length || event.defaultPrevented || event.altKey || event.ctrlKey ||
      event.metaKey || event.shiftKey) return
  const target = event.target
  const row = rowFor(target)
  if (target !== viewport.value && !row) return
  if (target instanceof HTMLElement && target.closest('[aria-expanded="true"], [role="menu"]')) return

  const instance = virtualizer.value
  const start = instance.range?.startIndex ?? 0
  const index = row ? Number(row.dataset.index) : start
  const last = props.items.length - 1
  let nextIndex: number
  switch (event.key) {
    case 'ArrowDown': nextIndex = row ? index + 1 : index; break
    case 'ArrowUp': nextIndex = index - 1; break
    case 'Home': nextIndex = 0; break
    case 'End': nextIndex = last; break
    default: return
  }
  event.preventDefault()
  nextIndex = Math.min(last, Math.max(0, nextIndex))
  const next = { index: nextIndex, key: getItemKey.value(nextIndex) }
  focusedRow.value = next
  instance.scrollToIndex(nextIndex)
  await nextTick()
  if (focusedRow.value === next) {
    viewport.value?.querySelector<HTMLElement>(`.virtual-row[data-index="${nextIndex}"]`)?.focus({ preventScroll: true })
  }
}

function scrollToEnd() {
  virtualizer.value.scrollToEnd()
}

defineExpose({ scrollToEnd })
</script>

<style scoped>
.virtual-list {
  min-height: 0;
  overflow: auto;
  overflow-anchor: none;
  scroll-padding-top: var(--virtual-header-height);
}

.virtual-header {
  position: sticky;
  top: 0;
  height: var(--virtual-header-height);
  z-index: 2;
}

.virtual-content {
  position: relative;
}

.virtual-row {
  position: absolute;
  width: 100%;
  box-sizing: border-box;
}

.virtual-row:focus-visible,
.virtual-list:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
</style>
