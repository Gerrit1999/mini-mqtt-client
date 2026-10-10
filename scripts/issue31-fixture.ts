// Browser-only fixture: Tauri/history/stores are mocked. Components and layout
// use production Vue, Element Plus, MessageList, MessagePayload and virtualizer.
import { reactive } from "vue";
import type { MqttMessage, MessageHistory } from "../src/types/mqtt";

const query = new URLSearchParams(location.search);
const count = Number(query.get("count") ?? 3000);
const encoder = new TextEncoder();
export function rows(total: number, start = 0, server = 1): MqttMessage[] {
  return Array.from({ length: total }, (_, index) => {
    const id = start + index + 1;
    const variation = Math.abs(id);
    const json = id % 3 === 0;
    return { id, seq: id, server_id: server, direction: id % 7 === 0 ? "publish" : "receive",
      operation_id: id % 7 === 0 ? `fixture-${server}-${id}` : undefined,
      topic: `device/${variation % 17}/${"long-topic/".repeat(variation % 4)}${id}`,
      payload: encoder.encode(json ? JSON.stringify({ id, values: Array.from({ length: variation % 13 + 2 }, (_, n) => `value-${n}-${"x".repeat(60)}`) }) : `payload-${id} ${"long payload ".repeat(variation % 30 + 1)}`),
      payload_type: json ? "json" : "text", qos: 1, retain: false,
      timestamp: new Date(1700000000000 + id * 1000).toISOString(),
      publish_status: id % 7 === 0 ? "confirmed" : undefined,
      scriptError: id % 11 === 0 ? "Example script error" : undefined };
  });
}
const history = (messages: MqttMessage[]): MessageHistory[] => messages.map((msg) => ({
  ...msg, payload: new TextDecoder().decode(msg.payload), payload_format: msg.payload_type,
  created_at: msg.timestamp,
}));
const data = reactive({ live: { 1: rows(count), 2: rows(40, 50000, 2) } as Record<number, MqttMessage[]>,
  history: {} as Record<number, MessageHistory[]>, more: true, delay: 0, exports: [] as string[] });
if (query.has("historyFirst")) {
  data.history[1] = history(rows(1));
  data.live[1] = [];
}
let finishInitialHistory: (() => void) | undefined;
let deferInitialHistory = query.has("deferInitialHistory");
export const server = reactive({ activeServerId: 1 });
export const app = reactive({ autoScroll: query.has("autoScroll"), messageLimit: 20000,
  locale: "en-US",
  setAutoScroll(value: boolean) { this.autoScroll = value; },
  setCopyToPublish(value: unknown) { (window as any).copied = value; },
  getDateLocale() { return this.locale; } });
export const useServerStore = () => server;
export const useAppStore = () => app;
export const useMqttStore = () => ({ getServerMessages: (id: number) => data.live[id] ?? [],
  getReceivedCount: (id: number) => data.live[id]?.length ?? 0, clearMessages: (id: number) => { data.live[id] = []; } });
export const useSubscriptionStore = () => ({ getSubscriptionByTopic: () => ({ color: "#228844" }) });
export const useMessageStore = () => reactive({ loading: false, loadingMore: false,
  getMessages: (id: number) => data.history[id] ?? [], getHasMoreHistory: () => data.more,
  async fetchMessageHistory(_id: number) {
    if (deferInitialHistory) {
      deferInitialHistory = false;
      await new Promise<void>((resolve) => { finishInitialHistory = resolve; });
    } else {
      await new Promise((resolve) => setTimeout(resolve, data.delay));
    }
  },
  async loadMoreMessageHistory(id: number) {
    await new Promise((resolve) => setTimeout(resolve, data.delay));
    const existing = data.history[id] ?? [];
    data.history[id] = history(rows(200, -existing.length - 200, id)).concat(existing);
    data.more = false;
  },
  fetchAllMessageHistory: async (id: number) => history(rows(count + 200, -200, id)),
  clearHistory: async (id: number) => { data.history[id] = []; },
});
export const save = async () => "/fixture/export";
export const writeTextFile = async (_path: string, content: string) => { data.exports.push(content); };
(window as any).fixture = { data, server, app,
  rows, finishInitialHistory: () => finishInitialHistory?.(),
  append() { const id = server.activeServerId; const last = data.live[id].at(-1)?.id ?? 0;
    data.live[id].push(...rows(10, last, id));
    window.dispatchEvent(new CustomEvent("mqtt-messages-flushed", { detail: { serverIds: [id] } })); },
};
