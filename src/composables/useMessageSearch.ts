import { computed, onScopeDispose, shallowRef, watch, type ComputedRef } from "vue";
import type { MqttMessage } from "@/types/mqtt";
import {
  buildMessageSearchRegex,
  createMessageMatcher,
  type MessageSearchBatch,
  type MessageSearchQuery,
} from "@/utils/messageSearch";

const SEARCH_DELAY_MS = 200;
const BATCH_ROWS = 128;
const BATCH_BYTES = 256 * 1024;

interface Search {
  query: MessageSearchQuery;
  cache: WeakMap<MqttMessage, boolean>;
}

export function useMessageSearch(
  source: ComputedRef<MqttMessage[]>,
  query: ComputedRef<MessageSearchQuery>,
  serverId: ComputedRef<number | null>,
) {
  const applied = shallowRef<{ query: MessageSearchQuery; matches: Set<MqttMessage> | null }>({
    query: query.value,
    matches: null,
  });
  let requested: Search | undefined;
  let running = false;
  let worker: Worker | undefined;
  let workerUnavailable = typeof Worker === "undefined";
  let finishBatch: ((hits: boolean[] | null) => void) | undefined;

  function stopWorker() {
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    finishBatch?.(null);
  }

  function sendBatch(batch: MessageSearchBatch): Promise<boolean[] | null> {
    return new Promise((resolve) => {
      finishBatch = (hits) => {
        finishBatch = undefined;
        resolve(hits);
      };
      const fail = () => {
        workerUnavailable = true;
        stopWorker();
      };
      try {
        if (!worker) {
          worker = new Worker(new URL("../workers/messageSearch.worker.ts", import.meta.url), { type: "module" });
          worker.onmessage = ({ data }: MessageEvent<boolean[]>) => finishBatch?.(data);
          worker.onerror = fail;
          worker.onmessageerror = fail;
        }
        worker.postMessage(batch);
      } catch {
        fail();
      }
    });
  }

  async function matchBatch(search: Search, messages: MqttMessage[], matches: Set<MqttMessage>) {
    const rows = messages.map(({ topic, payload }) => ({ topic, payload }));
    let hits = workerUnavailable ? null : await sendBatch({ query: search.query, rows });
    if (search !== requested) return;
    if (!hits) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (search !== requested) return;
      hits = rows.map(createMessageMatcher(search.query));
    }
    messages.forEach((message, index) => {
      const hit = hits[index];
      search.cache.set(message, hit);
      if (hit) matches.add(message);
    });
  }

  async function update() {
    const search = requested;
    if (!search || running) return;
    running = true;

    const snapshot = source.value;
    const matches = new Set<MqttMessage>();
    let batch: MqttMessage[] = [];
    let batchBytes = 0;
    try {
      for (const message of snapshot) {
        const cached = search.cache.get(message);
        if (cached !== undefined) {
          if (cached) matches.add(message);
          continue;
        }
        batch.push(message);
        batchBytes += message.payload?.byteLength ?? 0;
        if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) {
          await matchBatch(search, batch, matches);
          if (search !== requested) return;
          batch = [];
          batchBytes = 0;
        }
      }
      if (batch.length) await matchBatch(search, batch, matches);
      if (search === requested) applied.value = { query: search.query, matches };
    } finally {
      running = false;
      // Keep valid matches from this pass while processing newly arrived rows.
      if (requested && (search !== requested || snapshot !== source.value)) void update();
    }
  }

  watch([query, serverId], ([next, server], [previous, previousServer], onCleanup) => {
    const interrupt = requested?.query.useRegex && running;
    requested = undefined;
    if (interrupt) stopWorker();

    if (!next.keyword || !buildMessageSearchRegex(next)) {
      applied.value = { query: next, matches: next.keyword ? new Set() : null };
      return;
    }
    const start = () => {
      requested = { query: next, cache: new WeakMap() };
      void update();
    };
    if (server !== previousServer && next === previous) {
      start();
      return;
    }
    const timer = setTimeout(start, SEARCH_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  watch(source, () => void update());
  onScopeDispose(() => {
    requested = undefined;
    stopWorker();
  });

  return {
    appliedQuery: computed(() => applied.value.query),
    matchingMessages: computed((previous: MqttMessage[] | undefined) => {
      const { matches } = applied.value;
      const messages = source.value;
      if (!matches) return messages;
      const filtered = messages.filter((message) => matches.has(message));
      return previous?.length === filtered.length && filtered.every((message, index) => message === previous[index])
        ? previous : filtered;
    }),
  };
}
