import type { Subscription } from "@/types/mqtt";

export interface SubscriptionTopicTreeNode {
  key: string;
  segment: string;
  fullPath: string;
  depth: number;
  subscriptions: Subscription[];
  children: SubscriptionTopicTreeNode[];
}

interface MutableSubscriptionTopicTreeNode extends Omit<SubscriptionTopicTreeNode, "depth" | "children"> {
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
  node: MutableSubscriptionTopicTreeNode,
  depth: number
): SubscriptionTopicTreeNode {
  const segments = [node.segment];
  while (!node.subscriptions.length && node.childMap.size === 1) {
    [node] = node.childMap.values();
    segments.push(node.segment);
  }
  const children = Array.from(node.childMap.values())
    .sort(compareNodes)
    .map(child => finalizeNode(child, depth + 1));

  return {
    key: node.key,
    segment: segments.join("/"),
    fullPath: node.fullPath,
    depth,
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
          subscriptions: [],
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

  return Array.from(rootNodes.values()).sort(compareNodes).map(node => finalizeNode(node, 1));
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
