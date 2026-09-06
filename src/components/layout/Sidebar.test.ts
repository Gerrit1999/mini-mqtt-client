import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ElementPlus, { ElDialog } from "element-plus";
import type { Subscription } from "@/types/mqtt";
import SubscriptionTopicTree from "@/components/mqtt/SubscriptionTopicTree.vue";
import Sidebar from "./Sidebar.vue";

const appStore = vi.hoisted(() => ({
  theme: "light",
  updateInfo: null,
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  setCopyToPublish: vi.fn(),
  toggleTheme: vi.fn(),
}));

const serverStore = vi.hoisted(() => ({
  activeServer: { server: { id: 1 } },
  activeServerId: 1,
  servers: [],
  groups: [],
  fetchServers: vi.fn(),
  getGroupIdForServer: vi.fn(),
  isGroupCollapsed: vi.fn(),
}));

const subscriptionStore = vi.hoisted(() => ({
  loading: false,
  fetchSubscriptions: vi.fn(),
  getSubscriptionsByServer: vi.fn(() => []),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.7.3"),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/stores/app", () => ({
  useAppStore: () => appStore,
}));

vi.mock("@/stores/server", () => ({
  useServerStore: () => serverStore,
}));

vi.mock("@/stores/subscription", () => ({
  useSubscriptionStore: () => subscriptionStore,
}));

vi.mock("@/stores/mqtt", () => ({
  useMqttStore: () => ({
    subscriptionStates: new Map(),
    getConnectionStatus: () => "connected",
  }),
}));

vi.mock("@/utils/mqttErrorHandler", () => ({
  validatePublishTopic: (topic: string) => ({
    valid: topic.trim().length > 0 && !topic.includes("+") && !topic.includes("#"),
    error: "A publish topic must not contain wildcards",
  }),
}));

function subscription(topic: string): Subscription {
  return {
    id: 1,
    server_id: 1,
    topic,
    qos: 2,
    is_active: true,
  };
}

function mountSidebar() {
  return shallowMount(Sidebar, {
    global: {
      plugins: [ElementPlus],
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

describe("Sidebar subscription publish action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads a concrete subscription topic into the publish panel", async () => {
    const wrapper = mountSidebar();
    await flushPromises();
    const sub = subscription("factory/line-a/temperature");

    wrapper.findComponent(SubscriptionTopicTree).vm.$emit("publish", sub);

    expect(appStore.setCopyToPublish).toHaveBeenCalledWith({
      topic: sub.topic,
      payload: "",
      qos: 2,
      retain: false,
      payloadType: "text",
    });
  });

  it("asks for a concrete publish topic when the filter has wildcards", async () => {
    const wrapper = mountSidebar();
    await flushPromises();

    wrapper
      .findComponent(SubscriptionTopicTree)
      .vm.$emit("publish", subscription("factory/+/temperature"));
    await flushPromises();

    expect(appStore.setCopyToPublish).not.toHaveBeenCalled();
    expect(wrapper.findAllComponents(ElDialog)[1].props("modelValue")).toBe(true);
  });
});
