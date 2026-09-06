import type { Subscription } from "@/types/mqtt";

export interface SubscriptionTopicTreeNode {
  key: string;
  segment: string;
  fullPath: string;
  depth: number;
  subscriptions: Subscription[];
  children: SubscriptionTopicTreeNode[];
}

interface MutableSubscriptionTopicTreeNode extends SubscriptionTopicTreeNode {
  childMap: Map<string, MutableSubscriptionTopicTreeNode>;
}

function encodePath(segments: string[]): string {
  return segments.map((segment) => `${segment.length}:${segment}`).join("|");
}

function compareNodes(
  left: MutableSubscriptionTopicTreeNode,
  right: MutableSubscriptionTopicTreeNode
): number {
  if (left.segment === right.segment) return 0;
  return left.segment < right.segment ? -1 : 1;
}

function finalizeNode(
  node: MutableSubscriptionTopicTreeNode
): SubscriptionTopicTreeNode {
  const children = Array.from(node.childMap.values())
    .sort(compareNodes)
    .map(finalizeNode);

  return {
    key: node.key,
    segment: node.segment,
    fullPath: node.fullPath,
    depth: node.depth,
    subscriptions: [...node.subscriptions].sort(
      (left, right) => (left.id ?? 0) - (right.id ?? 0)
    ),
    children,
  };
}

export function buildSubscriptionTopicTree(
  subscriptions: Subscription[],
  searchQuery = ""
): SubscriptionTopicTreeNode[] {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const matchingSubscriptions = normalizedQuery
    ? subscriptions.filter((subscription) =>
        subscription.topic.toLocaleLowerCase().includes(normalizedQuery)
      )
    : subscriptions;
  const rootNodes = new Map<string, MutableSubscriptionTopicTreeNode>();

  for (const subscription of matchingSubscriptions) {
    const segments = subscription.topic.split("/");
    const pathSegments: string[] = [];
    let siblings = rootNodes;

    segments.forEach((segment, index) => {
      pathSegments.push(segment);
      const key = `topic:${encodePath(pathSegments)}`;
      let node = siblings.get(key);

      if (!node) {
        node = {
          key,
          segment,
          fullPath: pathSegments.join("/"),
          depth: index + 1,
          subscriptions: [],
          children: [],
          childMap: new Map(),
        };
        siblings.set(key, node);
      }

      if (index === segments.length - 1) {
        node.subscriptions.push(subscription);
      }

      siblings = node.childMap;
    });
  }

  return Array.from(rootNodes.values()).sort(compareNodes).map(finalizeNode);
}

export function collectExpandedTopicNodeKeys(
  nodes: SubscriptionTopicTreeNode[],
  maxDepth = Number.POSITIVE_INFINITY
): string[] {
  const keys: string[] = [];

  function visit(node: SubscriptionTopicTreeNode) {
    if (node.children.length > 0 && node.depth <= maxDepth) {
      keys.push(node.key);
    }
    node.children.forEach(visit);
  }

  nodes.forEach(visit);
  return keys;
}
