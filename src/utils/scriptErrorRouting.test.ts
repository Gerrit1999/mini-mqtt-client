import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { ElNotification } from "element-plus";
import { useMqttStore } from "@/stores/mqtt";
import { usePublishPipeline } from "@/composables/usePublishPipeline";
import { clearScriptCache } from "./scriptCache";
import { errorHandler } from "./errorHandler";
import type { ErrorLogEntry } from "./errorLogBuffer";
import { flushPromises } from "@vue/test-utils";

const listeners = vi.hoisted(() => new Map<string, (event: any) => Promise<void>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event, callback) => { listeners.set(event, callback); return () => {}; }),
}));
vi.mock("element-plus", () => ({ ElNotification: vi.fn(), ElMessage: { error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));

describe("real script error persistence routing", () => {
  let reason: string;
  let scriptId: number;
  let failedCommand: string | undefined;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.clearAllMocks();
    clearScriptCache();
    errorHandler.clearErrors();
    errorHandler.setLogToFileEnabled(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    reason = "original script reason";
    scriptId = 42;
    failedCommand = undefined;
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === failedCommand) throw new Error(`${command} unavailable`);
      if (command === "list_env_variables") return [{ name: "REGION", value: "north" }];
      if (command === "get_enabled_scripts") return [{
        id: scriptId, server_id: 999, name: "failing transform", enabled: true,
        script_type: args.scriptType, code: `throw new Error(${JSON.stringify(reason)})`,
      }];
      return undefined;
    });
  });
  afterEach(async () => {
    await errorHandler.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const request = (serverId = 7, topic = "device/{{REGION}}") => ({
    serverId, topic, payload: "original", qos: 0 as const, retain: false, format: "text" as const,
  });
  async function diskEntries() {
    await errorHandler.flush();
    return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "write_error_logs")
      .flatMap(([, args]) => (args as { entries: ErrorLogEntry[] }).entries)
      .map(entry => ({ ...entry, data: JSON.parse(entry.details!) }));
  }

  it("persists one occurrence per publish failure with actual context, identity and cause", async () => {
    const result = await usePublishPipeline().publish(request());
    expect(result).toMatchObject({ success: false, scriptError: reason, topic: "device/north" });
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "publish_message")).toBe(false);
    expect(ElNotification).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(useMqttStore().getServerMessages(7)[0]).toMatchObject({ scriptError: reason });
    const entries = await diskEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.aggregation.count).toBe(1);
    expect(entries[0].data.context).toEqual({ serverId: 7, topic: "device/north", command: "before_publish", scriptId: 42 });
    expect(entries[0].data.details.cause.message).toBe(reason);
    expect(entries[0].data.details.scriptName).toBe("failing transform");
  });

  it("persists one silent receive failure and still displays and saves the original payload", async () => {
    const store = useMqttStore();
    await store.initListeners();
    listeners.get("mqtt-message-batch")!({ payload: { messages: [{
      server_id: 7, topic: "received/topic", payload: [65, 66], qos: 1, retain: false,
      timestamp: "2026-10-09T00:00:00Z",
      seq: "0",
    }], dropped_total: 0, emit_failures_total: 0 } });
    await store.flushReceiveQueue();
    vi.advanceTimersByTime(50);
    expect(store.getServerMessages(7)[0]).toMatchObject({ payload: new Uint8Array([65, 66]), scriptError: reason });
    expect(invoke).toHaveBeenCalledWith("save_received_messages", { messages: [expect.objectContaining({ payload: "AB", topic: "received/topic" })] });
    expect(ElNotification).not.toHaveBeenCalled();
    const entries = await diskEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.aggregation.count).toBe(1);
    expect(entries[0].data.context).toEqual({ serverId: 7, topic: "received/topic", command: "after_receive", scriptId: 42 });
    expect(entries[0].data.details.cause.message).toBe(reason);
  });

  it("keeps distinct servers, topics, script identities and original reasons distinguishable", async () => {
    const { publish } = usePublishPipeline();
    await publish(request());
    await publish(request(8));
    await publish(request(7, "other/topic"));
    reason = "another reason";
    clearScriptCache();
    await publish(request());
    scriptId = 43;
    clearScriptCache();
    await publish(request());
    const entries = await diskEntries();
    expect(entries).toHaveLength(5);
    expect(entries.map(entry => entry.data.aggregation.count)).toEqual([1, 1, 1, 1, 1]);
    expect(entries.map(entry => entry.data.context)).toEqual([
      { serverId: 7, topic: "device/north", command: "before_publish", scriptId: 42 },
      { serverId: 8, topic: "device/north", command: "before_publish", scriptId: 42 },
      { serverId: 7, topic: "other/topic", command: "before_publish", scriptId: 42 },
      { serverId: 7, topic: "device/north", command: "before_publish", scriptId: 42 },
      { serverId: 7, topic: "device/north", command: "before_publish", scriptId: 43 },
    ]);
    expect(entries.map(entry => entry.data.details.cause.message)).toEqual([
      "original script reason", "original script reason", "original script reason", "another reason", "another reason",
    ]);
  });

  it("keeps an executed script failure persistent and silent when a publish is cancelled", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "list_env_variables") return [];
      if (command === "get_enabled_scripts") return [{
        id: 42, name: "delayed failure", enabled: true,
        code: "await new Promise(resolve => setTimeout(resolve, 100)); throw new Error('delayed reason')",
      }];
    });
    let cancelled = false;
    const pending = usePublishPipeline().publish(request(), () => cancelled);
    await flushPromises();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ error: "Publish cancelled" });
    expect(ElNotification).not.toHaveBeenCalled();
    const entries = await diskEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.aggregation.count).toBe(1);
    expect(entries[0].data.context).toEqual({ serverId: 7, topic: "device/{{REGION}}", command: "before_publish", scriptId: 42 });
  });

  it("retains publish logging for script cache failures", async () => {
    const command = "get_enabled_scripts";
    failedCommand = command;
    expect((await usePublishPipeline().publish(request())).success).toBe(false);
    const entries = await diskEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain(`${command} unavailable`);
  });

  it("returns environment load failures to the publish caller without submitting", async () => {
    failedCommand = "list_env_variables";
    expect(await usePublishPipeline().publish(request())).toMatchObject({
      success: false, error: "Failed to load environment variables: list_env_variables unavailable",
    });
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "publish_message")).toBe(false);
  });

  it("retains logging for script output validation failures", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "list_env_variables") return [];
      if (command === "get_enabled_scripts") return [{ id: 42, name: "invalid hex", code: "return 'not hex'", enabled: true }];
    });
    const result = await usePublishPipeline().publish({ ...request(), payload: "00", format: "hex" });
    expect(result.scriptError).toBeTruthy();
    expect(await diskEntries()).toHaveLength(1);
  });
});
