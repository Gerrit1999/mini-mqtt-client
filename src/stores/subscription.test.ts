import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import type { Subscription } from "@/types/mqtt";
import { useSubscriptionStore } from "./subscription";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/stores/env", () => ({
  useEnvStore: () => ({
    variables: [],
    loadVariables: vi.fn(),
    replaceVariables: (value: string) => value,
  }),
}));

vi.mock("@/utils/mqttErrorHandler", () => ({
  validateSubscribeTopic: () => ({ valid: true }),
}));

const mockedInvoke = vi.mocked(invoke);

function subscription(overrides: Partial<Subscription>): Subscription {
  return {
    id: 1,
    server_id: 7,
    topic: "factory/+/temperature",
    qos: 1,
    is_active: true,
    ...overrides,
  };
}

describe("subscription store retry", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue({ operation_id: "operation-1" });
  });

  it("re-subscribes an enabled saved configuration", async () => {
    const store = useSubscriptionStore();

    await store.retrySubscription(7, subscription({ is_active: true, qos: 2 }));

    expect(mockedInvoke).toHaveBeenCalledWith("mqtt_subscribe", {
      serverId: 7,
      topic: "factory/+/temperature",
      qos: 2,
    });
  });

  it("re-unsubscribes a disabled saved configuration", async () => {
    const store = useSubscriptionStore();

    await store.retrySubscription(7, subscription({ is_active: false }));

    expect(mockedInvoke).toHaveBeenCalledWith("mqtt_unsubscribe", {
      serverId: 7,
      topic: "factory/+/temperature",
    });
  });
});
