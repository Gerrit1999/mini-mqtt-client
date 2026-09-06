import { describe, expect, it } from "vitest";
import type { Subscription } from "@/types/mqtt";
import {
  buildSubscriptionTopicTree,
  collectExpandedTopicNodeKeys,
} from "./subscriptionTopicTree";

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

describe("subscriptionTopicTree", () => {
  it("builds a hierarchy from saved subscription filters", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "factory/line-a/temperature", { qos: 1 }),
      subscription(2, "factory/line-b/humidity", { qos: 2 }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("factory");
    expect(tree[0].children.map((node) => node.segment)).toEqual([
      "line-a",
      "line-b",
    ]);
    expect(tree[0].children[0].children[0].subscriptions[0]).toMatchObject({
      id: 1,
      topic: "factory/line-a/temperature",
      qos: 1,
    });
  });

  it("preserves leading and empty topic levels", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "/devices//temperature"),
    ]);

    expect(tree[0].segment).toBe("");
    expect(tree[0].children[0].segment).toBe("devices");
    expect(tree[0].children[0].children[0].segment).toBe("");
    expect(tree[0].children[0].children[0].children[0]).toMatchObject({
      segment: "temperature",
      fullPath: "/devices//temperature",
    });
  });

  it("treats MQTT wildcards as literal tree segments", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "devices/+/state"),
      subscription(2, "devices/#"),
    ]);

    expect(tree[0].children.map((node) => node.segment)).toEqual(["#", "+"]);
    expect(tree[0].children[1].children[0].segment).toBe("state");
  });

  it("allows a saved subscription to also be a parent node", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "factory"),
      subscription(2, "factory/line-a"),
    ]);

    expect(tree[0].subscriptions.map((item) => item.id)).toEqual([1]);
    expect(tree[0].children[0].subscriptions.map((item) => item.id)).toEqual([2]);
  });

  it("keeps duplicate saved configurations visible on the terminal node", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "factory/line-a", { qos: 0 }),
      subscription(2, "factory/line-a", { qos: 2 }),
    ]);

    expect(tree[0].children[0].subscriptions.map((item) => item.id)).toEqual([
      1,
      2,
    ]);
  });

  it("searches the complete filter and keeps ancestor context", () => {
    const tree = buildSubscriptionTopicTree(
      [
        subscription(1, "factory/line-a/temperature"),
        subscription(2, "factory/line-b/humidity"),
        subscription(3, "office/temperature"),
      ],
      "LINE-B/HUM"
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("factory");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].segment).toBe("line-b");
    expect(tree[0].children[0].children[0].subscriptions[0].id).toBe(2);
  });

  it("returns the first two branch levels for default expansion", () => {
    const tree = buildSubscriptionTopicTree([
      subscription(1, "factory/line-a/device-1/temperature"),
    ]);

    expect(collectExpandedTopicNodeKeys(tree, 2)).toEqual([
      tree[0].key,
      tree[0].children[0].key,
    ]);
    expect(collectExpandedTopicNodeKeys(tree)).toHaveLength(3);
  });
});
