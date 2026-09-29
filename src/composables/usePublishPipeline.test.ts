import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useMqttStore } from "@/stores/mqtt";
import { useEnvStore } from "@/stores/env";
import { usePublishPipeline } from "@/composables/usePublishPipeline";
import { clearScriptCache } from "@/utils/scriptCache";
import { ScriptEngine } from "@/utils/scriptEngine";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("element-plus", () => ({
  ElMessage: { error: vi.fn(), success: vi.fn() },
  ElNotification: vi.fn(),
}));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/utils/scriptEngine", () => ({
  ScriptEngine: { executeBeforePublish: vi.fn(async (_scripts: any[], payload: string) => payload) },
}));

const mockedInvoke = vi.mocked(invoke);

describe("usePublishPipeline", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    clearScriptCache();
    vi.clearAllMocks();
    vi.mocked(ScriptEngine.executeBeforePublish).mockClear();
    vi.mocked(ScriptEngine.executeBeforePublish).mockImplementation(
      async (_scripts, payload) => payload
    );
    mockedInvoke.mockImplementation(async (command: string, args?: any) => {
      if (command === "list_env_variables") {
        return args.serverId === 1
          ? [{ name: "REGION", value: "north" }]
          : [{ name: "REGION", value: "south" }];
      }
      if (command === "get_enabled_scripts") return [];
      if (command === "publish_message") {
        return {
          id: 1,
          server_id: args.serverId,
          direction: "publish",
          topic: args.message.topic,
          payload: args.message.payload,
          payload_format: args.message.format,
          qos: args.message.qos,
          retain: args.message.retain,
          operation_id: args.message.operation_id,
          publish_status: "confirmed",
          confirmed_at: "2026-01-01T00:00:00Z",
        };
      }
      return undefined;
    });
  });

  afterEach(() => vi.useRealTimers());

  it("uses per-server variables and the tracked publish contract for text, HEX, and Base64", async () => {
    const { publish } = usePublishPipeline();

    const textResult = await publish({
      serverId: 1,
      topic: "device/{{REGION}}",
      payload: "hello",
      qos: 1,
      retain: true,
      format: "text",
    });
    const hexResult = await publish({
      serverId: 2,
      topic: "device/{{REGION}}",
      payload: "00 FF",
      qos: 0,
      retain: false,
      format: "hex",
    });
    const base64Result = await publish({
      serverId: 1,
      topic: "device/{{REGION}}",
      payload: "AP+A",
      qos: 2,
      retain: false,
      format: "base64",
    });

    expect([textResult.success, hexResult.success, base64Result.success]).toEqual([
      true,
      true,
      true,
    ]);
    const published = mockedInvoke.mock.calls.filter(([command]) => command === "publish_message");
    expect(published.map(([, args]: any) => args.message)).toMatchObject([
      {
        topic: "device/north",
        payload: "hello",
        payload_bytes: Array.from(new TextEncoder().encode("hello")),
        format: "text",
      },
      {
        topic: "device/south",
        payload: "00 FF",
        payload_bytes: [0, 255],
        format: "hex",
      },
      {
        topic: "device/north",
        payload: "AP+A",
        payload_bytes: [0, 255, 128],
        format: "base64",
      },
    ]);
    for (const [, args] of published as any[]) {
      expect(args.message.operation_id).toBeTruthy();
      expect(args.message.payload_bytes).toBeDefined();
    }
  });

  it("does not call MQTT publish when a script throws or returns an invalid format", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "list_env_variables") return [];
      if (command === "get_enabled_scripts") return [{
        id: 1,
        server_id: 1,
        name: "before publish",
        script_type: "before_publish",
        code: "function process(payload) { return payload; }",
        enabled: true,
      }];
      return undefined;
    });
    const mqttStore = useMqttStore();
    const { publish } = usePublishPipeline();

    vi.mocked(ScriptEngine.executeBeforePublish).mockRejectedValueOnce(new Error("script boom"));
    const thrown = await publish({
      serverId: 1,
      topic: "device",
      payload: "original",
      qos: 0,
      retain: false,
      format: "text",
    });
    expect(thrown.success).toBe(false);
    expect(thrown.scriptError).toContain("script boom");
    expect(mockedInvoke).not.toHaveBeenCalledWith("publish_message", expect.anything());

    vi.mocked(ScriptEngine.executeBeforePublish).mockResolvedValueOnce("not hex");
    const invalid = await publish({
      serverId: 1,
      topic: "device",
      payload: "00",
      qos: 0,
      retain: false,
      format: "hex",
    });
    expect(invalid.success).toBe(false);
    expect(invalid.scriptError).toBeTruthy();
    expect(mockedInvoke).not.toHaveBeenCalledWith("publish_message", expect.anything());
    vi.advanceTimersByTime(100);
    expect(mqttStore.getServerMessages(1)).toHaveLength(2);
  });

  it("invalidates the affected server variable cache after edits", async () => {
    const mqttStore = useMqttStore();
    const envStore = useEnvStore();
    const { publish } = usePublishPipeline();
    const request = {
      serverId: 1,
      topic: "device/{{REGION}}",
      payload: "data",
      qos: 0 as const,
      retain: false,
      format: "text" as const,
    };

    await publish(request);
    envStore.variables = [{ id: 8, server_id: 1, name: "REGION", value: "changed" } as any];
    mockedInvoke.mockImplementation(async (command: string, args?: any) => {
      if (command === "list_env_variables") return [{ name: "REGION", value: "fresh" }];
      if (command === "get_enabled_scripts") return [];
      if (command === "publish_message") return {
        id: 2,
        server_id: args.serverId,
        publish_status: "sent",
      };
      if (command === "update_env_variable") return undefined;
      return undefined;
    });
    await envStore.updateVariable({ id: 8, value: "fresh" });
    await publish(request);

    const messages = mockedInvoke.mock.calls.filter(([command]) => command === "publish_message");
    expect((messages[1][1] as any).message.topic).toBe("device/fresh");
    expect(mqttStore.getCachedEnvVariables).toBeDefined();
  });
});
