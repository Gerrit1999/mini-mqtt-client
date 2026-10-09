import { describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync, writeFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import { useMqttStore } from "./mqtt";
import { clearScriptCache } from "@/utils/scriptCache";
import type { ReceiveBatch } from "@/types/mqtt";

const listeners = vi.hoisted(() => new Map<string, (event: any) => unknown>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { listeners.set(name, callback); return () => {}; }) }));
vi.mock("element-plus", () => ({ ElMessage: { error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/stores/app", () => ({ useAppStore: () => ({ messageLimit: 1000 }) }));

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe.skipIf(!process.env.ISSUE32_BENCH_FIXTURE)("receive production seam benchmark (mock IPC/SQLite, simulated broker)", () => {
  it("records sustained and burst before/after including overload", async () => {
    const path = "./.issue32-baseline.ts";
    const baseline = await import(/* @vite-ignore */ path);
    const workloads = JSON.parse(readFileSync(process.env.ISSUE32_BENCH_FIXTURE!, "utf8")) as {
      workload: string; received: number; emit_ipc: number; duration_ms: number;
      peak_pending_count: number; peak_pending_payload_bytes: number;
      events: { at_ms: number; batch: ReceiveBatch }[];
    }[];
    const results = [];
    for (const workload of workloads) {
      for (const mode of ["before", "after"] as const) {
        setActivePinia(createPinia()); clearScriptCache(); listeners.clear();
        Object.assign(baseline.baselineReceiveStats, { pendingCount: 0, pendingBytes: 0, peakCount: 0, peakBytes: 0 });
        let historyIpc = 0, persisted = 0;
        vi.mocked(invoke).mockImplementation(async (command, args: any) => {
          if (command === "get_enabled_scripts") return [];
          if (command === "save_received_message" || command === "save_received_messages") {
            historyIpc++; await wait(2); // Explicit simulated history IPC latency.
            persisted += command === "save_received_message" ? 1 : args.messages.length;
            return [];
          }
          return [];
        });
        const store = mode === "before" ? baseline.useMqttStore() : useMqttStore();
        await store.initListeners();
        const start = performance.now();
        const pending: Promise<unknown>[] = [];
        for (const event of workload.events) {
          if (workload.workload === "sustained") await wait(Math.max(0, event.at_ms - (performance.now() - start)));
          if (mode === "before") {
            for (const message of event.batch.messages) pending.push(Promise.resolve(listeners.get("mqtt-message")!({ payload: message })));
          } else listeners.get("mqtt-message-batch")!({ payload: event.batch });
        }
        await Promise.all(pending);
        if (mode === "after") await store.flushReceiveQueue();
        else while (baseline.baselineReceiveStats.pendingCount) await wait(5);
        const duration = performance.now() - start;
        const stats = mode === "before" ? baseline.baselineReceiveStats : store.receiveStats;
        const dropped = mode === "before" ? 0 : stats.dropped;
        expect(persisted + dropped).toBe(workload.received);
        if (mode === "after") expect(stats.peakCount).toBeLessThanOrEqual(2048);
        results.push({ workload: workload.workload, mode, received: workload.received, persisted, dropped,
          emit_ipc: mode === "before" ? workload.received : workload.emit_ipc,
          history_ipc: historyIpc, total_ipc: (mode === "before" ? workload.received : workload.emit_ipc) + historyIpc,
          processing_duration_ms: Number(duration.toFixed(2)), peak_pending_count: stats.peakCount,
          peak_pending_charged_bytes: stats.peakBytes,
          rust_batcher_duration_ms: mode === "after" ? workload.duration_ms : null,
          rust_peak_buffered_count: mode === "after" ? workload.peak_pending_count : null,
          rust_peak_buffered_payload_bytes: mode === "after" ? workload.peak_pending_payload_bytes : null,
        });
      }
    }
    writeFileSync(process.env.ISSUE32_BENCH_RESULT!, JSON.stringify(results, null, 2));
  }, 30000);
});
