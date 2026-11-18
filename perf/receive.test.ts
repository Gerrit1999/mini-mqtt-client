// @vitest-environment node
import { setTimeout as sleep } from "node:timers/promises";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { watch } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useMqttStore } from "@/stores/mqtt";
import type { ReceiveBatch, ReceivedHistoryInput } from "@/types/mqtt";
import { RECEIVE_LIMITS } from "@/utils/receiveQueue";
import { clearScriptCache } from "@/utils/scriptCache";

const { listeners, ipc } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: ReceiveBatch }) => void>(),
  ipc: {
    async save(_messages: ReceivedHistoryInput[]): Promise<number[]> {
      throw new Error("History mock has not been configured");
    },
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { messages: ReceivedHistoryInput[] }) => {
    if (command === "get_enabled_scripts") return [];
    if (command === "save_received_messages") return ipc.save(args.messages);
    throw new Error(`Unexpected benchmark IPC command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: ReceiveBatch }) => void) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  },
}));
vi.mock("element-plus", () => ({ ElMessage: { error: () => {} } }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/stores/app", () => ({ useAppStore: () => ({ messageLimit: DISPLAY_LIMIT }) }));

const SERVER_ID = 1;
const TOPIC = "perf/receive";
const PAYLOAD_BYTES = 128;
const MOCK_HISTORY_MS = 2;
const DISPLAY_LIMIT = 1000;

const soakSeconds = Number(process.env.MINI_MQTT_PERF_SOAK_SECONDS ?? 10);
const validSoakSeconds = Number.isInteger(soakSeconds) && soakSeconds >= 1 && soakSeconds <= 3600;

async function runReceive(name: string, batches: number, batchSize: number, intervalMs: number) {
  const pinia = createPinia();
  setActivePinia(pinia);
  clearScriptCache();
  const store = useMqttStore();
  let ipcCalls = 0;
  let persisted = 0;
  let peakRetained = 0;
  let offered = 0;

  // Plain mocks keep only counters, so the benchmark doesn't retain IPC arguments.
  ipc.save = async (messages) => {
    ipcCalls++;
    await sleep(MOCK_HISTORY_MS);
    return messages.map(() => ++persisted);
  };
  const stopWatching = watch(
    () => store.getServerMessages(SERVER_ID).length,
    (length) => { peakRetained = Math.max(peakRetained, length); },
    { flush: "sync" },
  );

  try {
    await store.initListeners();
    const emit = listeners.get("mqtt-message-batch");
    if (!emit) throw new Error("The receive event listener was not registered");

    const start = performance.now();
    for (let batch = 0; batch < batches; batch++) {
      if (batch > 0 && intervalMs > 0) await sleep(intervalMs);
      const timestamp = new Date().toISOString();
      const messages = Array.from({ length: batchSize }, () => {
        const seq = String(++offered);
        const payload = Array.from(seq.padEnd(PAYLOAD_BYTES, "x"), (char) => char.charCodeAt(0));
        return { server_id: SERVER_ID, topic: TOPIC, payload, qos: 0, retain: false, timestamp, seq };
      });
      emit({ payload: { messages, dropped_total: 0, emit_failures_total: 0 } });
    }
    const lastOffer = performance.now();
    await store.flushReceiveQueue();
    const finished = performance.now();

    const stats = store.receiveStats;
    const expectedAccepted = intervalMs === 0 ? RECEIVE_LIMITS.count : offered;
    const retained = store.getServerMessages(SERVER_ID);
    const expectedRetained = Math.min(DISPLAY_LIMIT, expectedAccepted);
    expect(store.getReceivedCount(SERVER_ID)).toBe(offered);
    expect(stats.accepted).toBe(expectedAccepted);
    expect(stats.dropped).toBe(offered - expectedAccepted);
    expect(persisted + stats.dropped).toBe(offered);
    expect(stats.failures + stats.backendDropped + stats.emitFailures).toBe(0);
    expect(stats.pendingCount).toBe(0);
    expect(stats.pendingBytes).toBe(0);
    expect(stats.peakCount).toBeLessThanOrEqual(RECEIVE_LIMITS.count);
    expect(stats.peakBytes).toBeLessThanOrEqual(RECEIVE_LIMITS.bytes);
    expect(peakRetained).toBeLessThanOrEqual(DISPLAY_LIMIT);
    expect(retained.map((message) => message.receive_seq)).toEqual(
      Array.from({ length: expectedRetained }, (_, index) =>
        String(expectedAccepted - expectedRetained + index + 1),
      ),
    );

    const totalMs = finished - start;
    console.log(`PERF ${JSON.stringify({
      boundary: "pinia-receive-mock-ipc",
      scenario: name,
      node: process.version,
      batches,
      batch_size: batchSize,
      interval_ms: intervalMs,
      payload_bytes: PAYLOAD_BYTES,
      mock_history_ms: MOCK_HISTORY_MS,
      offered,
      accepted: stats.accepted,
      dropped: stats.dropped,
      mock_persisted: persisted,
      mock_history_calls: ipcCalls,
      failures: stats.failures,
      offer_ms: Math.round(lastOffer - start),
      drain_ms: Math.round(finished - lastOffer),
      total_ms: Math.round(totalMs),
      mock_persisted_per_second: Math.round(persisted * 1000 / totalMs),
      peak_pending_count: stats.peakCount,
      peak_pending_charged_bytes: stats.peakBytes,
      final_pending_count: stats.pendingCount,
      final_pending_charged_bytes: stats.pendingBytes,
      pending_count_limit: RECEIVE_LIMITS.count,
      pending_charged_bytes_limit: RECEIVE_LIMITS.bytes,
      peak_retained_count: peakRetained,
      final_retained_count: retained.length,
      retained_count_limit: DISPLAY_LIMIT,
    })}`);
  } finally {
    await store.flushReceiveQueue();
    stopWatching();
    listeners.clear();
    clearScriptCache();
    disposePinia(pinia);
  }
}

describe.skipIf(process.env.MINI_MQTT_PERF !== "1")("Pinia receive benchmark", () => {
  it("accounts for all drops during a queue-saturating burst", async () => {
    await runReceive("burst", Math.ceil(4 * RECEIVE_LIMITS.count / 128), 128, 0);
  }, 30_000);

  it("bounds pending reservations and retained rows under sustained load", async () => {
    if (!validSoakSeconds) throw new Error("MINI_MQTT_PERF_SOAK_SECONDS must be an integer from 1 to 3600");
    await runReceive("soak", soakSeconds * 50, 64, 20);
  }, (validSoakSeconds ? soakSeconds : 1) * 2000 + 30_000);
});
