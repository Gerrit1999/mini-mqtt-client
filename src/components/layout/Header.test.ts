import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Header from "./Header.vue";

const mqttState = vi.hoisted(() => ({
  status: "connected",
  protocolVersion: "5.0",
  reconnectAttempt: undefined as number | undefined,
  retryInMs: undefined as number | undefined,
  error: undefined as string | undefined,
  disconnect: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...await importOriginal<typeof import("vue-i18n")>(),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(" ")}` : key,
  }),
}));

vi.mock("@/stores/server", () => ({
  useServerStore: () => ({
    activeServer: {
      server: {
        id: 1,
        name: "Test",
        host: "localhost",
        port: 1883,
        protocol: "mqtt",
        protocol_version: "3.1.1",
        keep_alive: 60,
        clean_session: true,
        use_tls: false,
      },
    },
  }),
}));

vi.mock("@/stores/mqtt", () => ({
  useMqttStore: () => ({
    getConnectionStatus: () => mqttState.status,
    getConnectionProtocolVersion: () => mqttState.protocolVersion,
    getConnectionError: () => mqttState.error,
    getReconnectAttempt: () => mqttState.reconnectAttempt,
    getRetryInMs: () => mqttState.retryInMs,
    connect: vi.fn(),
    disconnect: mqttState.disconnect,
  }),
}));

vi.mock("@/stores/subscription", () => ({
  useSubscriptionStore: () => ({
    getSubscriptionsByServer: () => [],
  }),
}));

vi.mock("element-plus", () => ({
  ElMessage: { error: vi.fn() },
}));

describe("Header", () => {
  beforeEach(() => {
    mqttState.status = "connected";
    mqttState.protocolVersion = "5.0";
    mqttState.reconnectAttempt = undefined;
    mqttState.retryInMs = undefined;
    mqttState.error = undefined;
    mqttState.disconnect.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("连接后显示后端确认的实际 MQTT 协议版本", () => {
    const wrapper = mount(Header, {
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          ElTag: { template: "<span><slot /></span>" },
          ElButton: { template: "<button><slot /></button>" },
          ElTooltip: { template: "<span><slot /></span>" },
        },
      },
    });

    expect(wrapper.text()).toContain("MQTT 5.0");
    expect(wrapper.text()).not.toContain("MQTT 3.1.1");
  });

  it("重连时显示进度和最近错误并允许主动取消", async () => {
    mqttState.status = "reconnecting";
    mqttState.reconnectAttempt = 3;
    mqttState.retryInMs = 1750;
    mqttState.error = "Connection error: network unavailable";
    const wrapper = mount(Header, {
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          ElTag: { template: "<span><slot /></span>" },
          ElButton: { template: "<button><slot /></button>" },
          ElTooltip: { template: "<span><slot /></span>" },
        },
      },
    });

    expect(wrapper.text()).toContain("header.status.reconnecting 3");
    expect(wrapper.text()).toContain("header.status.retryingIn 1.8");
    expect(wrapper.text()).toContain("header.connectionError.connectionLost");
    expect(wrapper.text()).toContain("network unavailable");
    const disconnectButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "header.disconnect");
    expect(disconnectButton).toBeDefined();
    await disconnectButton!.trigger("click");
    expect(mqttState.disconnect).toHaveBeenCalledWith(1);
  });

  it("重连时显示系统错误类别和原文", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    mqttState.status = "reconnecting";
    mqttState.error = "Connection error: I/O: 远程主机强迫关闭了一个现有的连接。 (os error 10054)";
    const wrapper = mount(Header, {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          ElTag: { template: "<span><slot /></span>" },
          ElButton: { template: "<button><slot /></button>" },
        },
      },
    });

    expect(wrapper.get(".reconnect-detail").text()).toBe(`Connection reset: ${mqttState.error}`);
  });
});
