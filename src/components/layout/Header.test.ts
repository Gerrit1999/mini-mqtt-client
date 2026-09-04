import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import Header from "./Header.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
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
    getConnectionStatus: () => "connected",
    getConnectionProtocolVersion: () => "5.0",
    subscribe: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
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
});
