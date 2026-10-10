import { flushPromises, shallowMount, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ElementPlus, { ElDialog, ElInput, ElMessageBox } from "element-plus";
import { defineComponent, h, type VNode } from 'vue';
import type { Subscription } from "@/types/mqtt";
import SubscriptionTopicTree from "@/components/mqtt/SubscriptionTopicTree.vue";
import Sidebar from "./Sidebar.vue";
import { createPinia, setActivePinia } from 'pinia';
import { useUpdaterStore } from '@/stores/updater';

const appStore = vi.hoisted(() => ({
  theme: "light",
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
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => ({ version: '1.9.0', download: async () => {}, close: async () => {} }) }));

vi.mock("vue-i18n", async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
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
    connectionStates: new Map(),
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
      renderStubDefaultSlot: true,
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

describe("Sidebar subscription publish action", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('opens existing update feedback from the version badge without installing', async () => {
    const updater = useUpdaterStore();
    updater.info = { hasUpdate: true, latestVersion: 'v1.9.0', currentVersion: '1.8.1' };
    updater.deferred = true;
    const wrapper = mountSidebar();
    await flushPromises();
    await wrapper.get('.version-tag').trigger('click');
    expect(updater.deferred).toBe(false);
    wrapper.unmount();
  });

  it('protects changed subscription forms and releases them on Cancel', async () => {
    const updater = useUpdaterStore();
    await updater.check();
    await updater.download();
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel');
    const wrapper = mountSidebar();
    await wrapper.get('[aria-label="sidebar.addSubscription"]').trigger('click');
    const messageText = () => {
      const message = mount(defineComponent({ render: () => h('div', [confirm.mock.calls.at(-1)![0] as VNode]) }));
      const text = message.text();
      message.unmount();
      return text;
    };
    await updater.install();
    expect(messageText()).not.toContain('Unsaved subscription');
    wrapper.findAllComponents(ElInput).find(input => input.props('placeholder') === 'e.g., sensor/+/temperature')!.vm.$emit('update:modelValue', 'changed/topic');
    await updater.install();
    expect(messageText()).toContain('Unsaved subscription');
    wrapper.findAllComponents(ElDialog)[0].vm.$emit('update:modelValue', false);
    await updater.install();
    expect(messageText()).not.toContain('Unsaved subscription');
    wrapper.unmount();
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
    wrapper.unmount();
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
    wrapper.unmount();
  });
});
