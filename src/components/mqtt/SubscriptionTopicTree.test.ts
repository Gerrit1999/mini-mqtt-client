import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ElementPlus, { ElDropdown } from "element-plus";
import type {
  Subscription,
  SubscriptionRuntimeState,
} from "@/types/mqtt";
import SubscriptionTopicTree from "./SubscriptionTopicTree.vue";

function subscription(
  id: number,
  topic: string,
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    id,
    server_id: 1,
    topic,
    qos: 0,
    is_active: true,
    ...overrides,
  };
}

function runtimeState(
  topic: string,
  overrides: Partial<SubscriptionRuntimeState>
): SubscriptionRuntimeState {
  return {
    server_id: 1,
    topic,
    operation: "subscribe",
    status: "active",
    requested_qos: 0,
    operation_id: `operation-${topic}`,
    ...overrides,
  };
}

function mountTree(
  subscriptions: Subscription[],
  runtimeStates = new Map<string, SubscriptionRuntimeState>()
) {
  const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: {
      "en-US": {
        sidebar: {
          topicTree: {
            searchPlaceholder: "Search subscription topics",
            emptyLevel: "(empty level)",
            noSubscriptions: "No subscriptions",
            noMatches: "No matching subscriptions",
            status: {
              active: "Active",
              pending: "Pending",
              failed: "Failed",
              disabled: "Disabled",
            },
            actions: {
              enable: "Enable subscription {topic}",
              disable: "Disable subscription {topic}",
              more: "Subscription actions for {topic}",
              retry: "Retry subscription {topic}",
              publish: "Use for publish",
              edit: "Edit",
              delete: "Delete",
            },
          },
        },
      },
    },
  });

  return mount(SubscriptionTopicTree, {
    attachTo: document.body,
    props: { subscriptions, runtimeStates },
    global: {
      plugins: [ElementPlus, i18n],
    },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SubscriptionTopicTree", () => {
  it("splits a compact path when a sibling is added and merges it again on removal", async () => {
    const status = subscription(1, "device/001/status");
    const temperature = subscription(2, "device/001/temp");
    const wrapper = mountTree([status]);
    const labels = () => wrapper.findAll(".topic-node-label").map(label => label.text());

    expect(labels()).toEqual(["device/001/status"]);
    await wrapper.setProps({ subscriptions: [status, temperature] });
    await flushPromises();
    expect(labels()).toEqual(["device/001", "status", "temp"]);
    await wrapper.setProps({ subscriptions: [status] });
    await flushPromises();
    expect(labels()).toEqual(["device/001/status"]);
    await wrapper.get('[aria-label="Disable subscription device/001/status"]').trigger("click");
    expect(wrapper.emitted("toggle")?.[0]).toEqual([status, false]);
  });

  it("shows a single matching filter as one row with its complete path", async () => {
    const wrapper = mountTree([
      subscription(1, "factory/line-a/temperature"),
      subscription(2, "factory/line-b/humidity"),
      subscription(3, "office/temperature"),
    ]);

    await wrapper.get('[data-testid="topic-tree-search"]').setValue("line-b/hum");
    await flushPromises();

    expect(wrapper.findAll('[role="treeitem"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("factory/line-b/humidity");
    expect(wrapper.text()).not.toContain("line-a");
    expect(wrapper.text()).not.toContain("office");
  });

  it("shows runtime status, granted QoS, the complete topic and retry action", async () => {
    const topic = "sensor/+/temperature";
    const sub = subscription(1, topic, { qos: 2 });
    const states = new Map([
      [
        topic,
        runtimeState(topic, {
          status: "failed",
          requested_qos: 2,
          error: "Subscription acknowledgement timed out",
        }),
      ],
    ]);
    const wrapper = mountTree([sub], states);

    const status = wrapper.get('[data-testid="subscription-status-1"]');
    expect(status.text()).toContain("Failed");
    expect(status.attributes("title")).toContain("acknowledgement timed out");
    expect(wrapper.get('[data-testid="topic-label-sensor/+/temperature"]').attributes("title")).toBe(topic);

    const retryButton = wrapper.get(
      '[aria-label^="Retry subscription sensor/+/temperature"]'
    );
    expect(retryButton.attributes("aria-label")).toContain(
      "Subscription acknowledgement timed out"
    );
    await retryButton.trigger("click");
    expect(wrapper.emitted("retry")?.[0]).toEqual([sub]);
  });

  it("shows pending and disabled states and blocks pending operations", () => {
    const pendingTopic = "factory/pending";
    const disabledTopic = "factory/disabled";
    const pending = subscription(1, pendingTopic);
    const disabled = subscription(2, disabledTopic, { is_active: false });
    const states = new Map([
      [pendingTopic, runtimeState(pendingTopic, { status: "pending" })],
    ]);
    const wrapper = mountTree([pending, disabled], states);

    expect(wrapper.get('[data-testid="subscription-status-1"]').text()).toContain(
      "Pending"
    );
    expect(wrapper.get('[data-testid="subscription-status-2"]').text()).toContain(
      "Disabled"
    );
    expect(
      wrapper.get('[aria-label="Disable subscription factory/pending"]').attributes("disabled")
    ).toBeDefined();
    expect(
      wrapper.get('[aria-label="Enable subscription factory/disabled"]').attributes("role")
    ).toBe("switch");
  });

  it("shows Broker-granted QoS and emits toggle and menu actions", async () => {
    const topic = "factory/line-a";
    const sub = subscription(1, topic, { qos: 2 });
    const states = new Map([
      [topic, runtimeState(topic, { granted_qos: 1, requested_qos: 2 })],
    ]);
    const wrapper = mountTree([sub], states);

    expect(wrapper.text()).toContain("Q2 → Q1");
    expect(wrapper.text()).toContain("Active");

    await wrapper.get('[aria-label="Disable subscription factory/line-a"]').trigger("click");
    expect(wrapper.emitted("toggle")?.[0]).toEqual([sub, false]);

    const dropdown = wrapper.findComponent(ElDropdown);
    dropdown.vm.$emit("command", "publish");
    dropdown.vm.$emit("command", "edit");
    dropdown.vm.$emit("command", "delete");
    await flushPromises();

    expect(wrapper.emitted("publish")?.[0]).toEqual([sub]);
    expect(wrapper.emitted("edit")?.[0]).toEqual([sub]);
    expect(wrapper.emitted("delete")?.[0]).toEqual([sub]);
  });

  it("supports keyboard expansion through treeitem focus", async () => {
    const wrapper = mountTree([
      subscription(1, "factory/line-a/device-1/temperature"),
      subscription(2, "factory/line-a/device-1"),
      subscription(3, "factory/line-a"),
      subscription(4, "factory"),
    ]);
    await flushPromises();

    const deviceNode = wrapper.get('[data-key$="8:device-1"]');
    expect(deviceNode.attributes("aria-expanded")).toBe("false");

    (deviceNode.element as HTMLElement).focus();
    await deviceNode.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();

    expect(deviceNode.attributes("aria-expanded")).toBe("true");
  });
});
