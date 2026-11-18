import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useMqttStore } from "@/stores/mqtt";
import { useEnvStore } from "@/stores/env";
import { usePublishPipeline } from "@/composables/usePublishPipeline";
import { clearScriptCache } from "@/utils/scriptCache";
import { decodePayload } from "@/utils/payloadCodec";
import type { Script } from "@/stores/script";
import type { PayloadFormat, PublishPayload } from "@/types/mqtt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("element-plus", () => ({
  ElMessage: { error: vi.fn(), success: vi.fn() },
  ElNotification: vi.fn(),
}));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
const mockedInvoke = vi.mocked(invoke);

function setPublishScripts(...codes: string[]) {
  const backend = mockedInvoke.getMockImplementation()!;
  const scripts: Script[] = codes.map((code, id) => ({
    id, server_id: 1, name: `publish transform ${id}`, script_type: "before_publish", code, enabled: true,
  }));
  mockedInvoke.mockImplementation((command, args) => command === "get_enabled_scripts"
    ? Promise.resolve(scripts)
    : backend(command, args));
}

describe("usePublishPipeline", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    clearScriptCache();
    vi.clearAllMocks();
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

  it.each(["get_enabled_scripts", "list_env_variables"])(
    "aborts on %s failure and retries through the real cache/store",
    async (failedCommand) => {
      const backend = mockedInvoke.getMockImplementation()!;
      let fail = true;
      mockedInvoke.mockImplementation(async (command, args) => {
        if (command === failedCommand && fail) throw new Error(`${command} unavailable`);
        return backend(command, args);
      });
      const { publish } = usePublishPipeline();
      const request = {
        serverId: 1, topic: "device/{{REGION}}", payload: "{{REGION}}",
        qos: 1 as const, retain: false, format: "text" as const,
      };

      const result = await publish(request);
      expect(result.success).toBe(false);
      expect(result.error).toContain(`${failedCommand} unavailable`);
      expect(mockedInvoke).not.toHaveBeenCalledWith("publish_message", expect.anything());

      fail = false;
      expect(await publish(request)).toMatchObject({
        success: true, topic: "device/north", payload: "north",
      });
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === failedCommand)).toHaveLength(2);
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "publish_message")).toHaveLength(1);
    }
  );

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
    setPublishScripts(
      'if (topic === "device/failure") throw new Error("script boom"); return "not hex";',
      'if (topic === "device/failure") throw new Error("chain should have stopped");'
    );
    const mqttStore = useMqttStore();
    const { publish } = usePublishPipeline();

    const thrown = await publish({
      serverId: 1,
      topic: "device/failure",
      payload: "original",
      qos: 0,
      retain: false,
      format: "text",
    });
    expect(thrown.success).toBe(false);
    expect(thrown.scriptError).toContain("script boom");
    expect(mockedInvoke).not.toHaveBeenCalledWith("publish_message", expect.anything());

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

  it.each<{ format: PayloadFormat; input: string; code: string; storedFormat: PayloadFormat; stored: string; bytes: number[] }>([
    { format: "hex", input: "41 00 FF 80 42", code: "return payloadBytes.subarray(1, -1);", storedFormat: "hex", stored: "00FF80", bytes: [0, 255, 128] },
    { format: "base64", input: "QQD/gEI=", code: "return payloadBytes.subarray(1, -1);", storedFormat: "base64", stored: "AP+A", bytes: [0, 255, 128] },
    { format: "json", input: '{"value":1}', code: "return new Uint8Array([0, 255, 128]);", storedFormat: "hex", stored: "00FF80", bytes: [0, 255, 128] },
    { format: "text", input: "word", code: "return payloadBytes.subarray(payloadBytes.length);", storedFormat: "text", stored: "", bytes: [] },
  ])("preserves binary script output in wire bytes, display and history for $format", async ({ format, input, code, storedFormat, stored, bytes }) => {
    setPublishScripts(code, "return pako.ungzip(pako.gzip(payloadBytes));", "return payload;");
    const mqttStore = useMqttStore();
    const { publish } = usePublishPipeline();

    const result = await publish({ serverId: 1, topic: "binary", payload: input, qos: 0, retain: false, format });

    expect(result).toMatchObject({ success: true, payload: stored });
    const [, args] = mockedInvoke.mock.calls.find(([command]) => command === "publish_message")!;
    const { message } = args as { message: PublishPayload };
    expect(message).toMatchObject({ payload: stored, payload_bytes: bytes, format: storedFormat });
    expect(Array.from(decodePayload(message.payload, message.format))).toEqual(bytes);
    expect(mqttStore.getServerMessages(1)[0]).toMatchObject({ payload: new Uint8Array(bytes), payload_type: storedFormat });
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
