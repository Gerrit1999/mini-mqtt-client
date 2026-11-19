<template>
  <details class="release-notes">
    <summary>{{ $t('updater.releaseNotes') }}</summary>
    <div
      class="release-notes-content"
      role="region"
      :aria-label="$t('updater.releaseNotes')"
      tabindex="0"
      v-html="formattedNotes"
    />
  </details>
</template>

<script lang="ts">
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true })
markdown.validateLink = url => /^https?:\/\//i.test(url)
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}
// Show the description of an image without fetching it from a release note.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content)
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ body: string }>()
const formattedNotes = computed(() => markdown.render(props.body))
</script>

<style scoped>
.release-notes {
  margin-top: 10px;
  border-top: 1px solid var(--app-border-color);
}

summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 2px 3px 0;
  list-style: none;
  font-weight: 500;
  cursor: pointer;
}

summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--primary-color); }

summary::after {
  content: '';
  width: 6px;
  height: 6px;
  border: solid currentColor;
  border-width: 0 1px 1px 0;
  transform: rotate(45deg);
}

.release-notes[open] summary::after { transform: rotate(225deg); }

.release-notes-content {
  max-height: min(28vh, 220px);
  margin-top: 6px;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--app-control-radius);
  background: var(--app-bg-color);
  line-height: 1.65;
}

.release-notes-content :deep(> * + *) { margin-top: 8px; }
.release-notes-content :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: 1em; }
.release-notes-content :deep(:is(h1, h2)) { font-size: 1.08em; }
.release-notes-content :deep(:is(ul, ol)) { padding-inline-start: 18px; }
.release-notes-content :deep(a) { color: var(--primary-color); }

.release-notes-content :deep(code) {
  font-family: "Fira Code", "Consolas", monospace;
  font-size: 0.92em;
}

.release-notes-content :deep(:not(pre) > code),
.release-notes-content :deep(pre) {
  background: var(--card-bg);
  border-radius: 4px;
  padding: 1px 4px;
}

.release-notes-content :deep(pre) {
  padding: 6px 8px;
  overflow-x: auto;
}

.release-notes-content :deep(blockquote) {
  border-inline-start: 2px solid var(--app-border-color);
  padding-inline-start: 8px;
  color: var(--app-text-secondary);
}

.release-notes-content :deep(hr) {
  border: 0;
  border-top: 1px solid var(--app-border-color);
}

.release-notes-content :deep(table) { border-collapse: collapse; }

.release-notes-content :deep(:is(th, td)) {
  border: 1px solid var(--app-border-color);
  padding: 3px 6px;
}
</style>
