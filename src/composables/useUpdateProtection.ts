import { onScopeDispose, ref } from 'vue'

export type UpdateImpactKind = 'scheduled' | 'timed' | 'publish' | 'server' | 'subscription' | 'template' | 'script' | 'env' | 'settings'
const entries = new Map<symbol, { kind: UpdateImpactKind; read: () => string | false }>()

// Read getters at the irreversible boundary, including drafts hidden by v-show.
// Tokens stay private: confirmation displays only localized categories.
export function useUpdateProtection(kind: UpdateImpactKind, read: () => string | false) {
  const id = Symbol(kind)
  entries.set(id, { kind, read })
  onScopeDispose(() => entries.delete(id))
}

export function getUpdateImpacts() {
  return [...entries].flatMap(([id, entry]) => {
    const token = entry.read()
    return token === false ? [] : [{ id, kind: entry.kind, token }]
  })
}

export function useUpdateDraft(kind: UpdateImpactKind, read: () => unknown, active: () => boolean) {
  const snapshot = () => JSON.stringify(read())
  const baseline = ref(snapshot())
  function markSaved(saved = snapshot()) { baseline.value = saved }
  useUpdateProtection(kind, () => {
    const value = JSON.stringify(read())
    return active() && value !== baseline.value ? value : false
  })
  return { markSaved, snapshot }
}
