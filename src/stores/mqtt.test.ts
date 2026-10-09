import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useMqttStore } from "./mqtt";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage } from "element-plus";
import { ScriptEngine } from "@/utils/scriptEngine";
import { clearScriptCache } from "@/utils/scriptCache";
import { RECEIVE_LIMITS } from "@/utils/receiveQueue";

const { translate } = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
}));

// 单条接收回归通过批量事件监听器包装执行
let mqttMessageListener: ((event: { payload: any }) => Promise<void>) | null = null;
let mqttBatchListener: ((event: { payload: any }) => void) | null = null;
let wireSeq = 0;
let connectionStateListener: ((event: { payload: any }) => void) | null = null;
let subscriptionStateListener: ((event: { payload: any }) => void) | null = null;
let publishStateListener: ((event: { payload: any }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: any) => {
    if (event === "mqtt-connection-state") {
      connectionStateListener = callback;
    } else if (event === "mqtt-subscription-state") {
      subscriptionStateListener = callback;
    } else if (event === "mqtt-publish-state") {
      publishStateListener = callback;
    } else if (event === "mqtt-message-batch") {
      mqttBatchListener = callback;
      // Existing single-receive regressions now travel through the batch path.
      mqttMessageListener = async ({ payload }) => {
        callback({ payload: { messages: [{ ...payload, seq: String(wireSeq++) }], dropped_total: 0, emit_failures_total: 0 } });
        await useMqttStore().flushReceiveQueue();
      };
    }
    return () => {};
  }),
}));

vi.mock("element-plus", async (importOriginal) => {
  const mod = await importOriginal<typeof import("element-plus")>();
  return {
    ...mod,
    ElMessage: {
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

vi.mock("@/i18n", () => ({
  default: {
    global: {
      t: translate,
    },
  },
}));

vi.mock("@/stores/app", () => ({
  useAppStore: () => ({
    messageLimit: 1000,
  }),
}));

vi.mock("@/utils/scriptEngine", () => ({
  ScriptEngine: {
    executeAfterReceive: vi.fn((_scripts: any[], payload: string) =>
      Promise.resolve(payload)
    ),
  },
}));

vi.mock("@/utils/errorHandler", () => ({
  handleScriptError: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("useMqttStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mqttMessageListener = null;
    mqttBatchListener = null;
    wireSeq = 0;
    connectionStateListener = null;
    subscriptionStateListener = null;
    publishStateListener = null;
    vi.clearAllMocks();
    clearScriptCache();
    vi.mocked(ScriptEngine.executeAfterReceive).mockImplementation(async (_scripts, payload) => payload);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("连接协议状态", () => {
    it("保存后端确认的实际协议版本和能力", async () => {
      const store = useMqttStore();
      await store.initListeners();

      connectionStateListener!({
        payload: {
          server_id: 1,
          status: "connected",
          protocol_version: "5.0",
          capabilities: ["publish_properties", "session_expiry", "topic_alias"],
        },
      });

      expect(store.getConnectionProtocolVersion(1)).toBe("5.0");
      expect(store.supportsCapability(1, "publish_properties")).toBe(true);
      expect(store.supportsCapability(1, "session_expiry")).toBe(true);
      expect(store.supportsCapability(1, "topic_alias")).toBe(true);
    });

    it("连接预检失败时记录明确错误状态", async () => {
      const store = useMqttStore();
      mockedInvoke.mockRejectedValueOnce(
        "Unsupported MQTT protocol version: 4.0. Supported versions: 3.1.1, 5.0"
      );

      await expect(store.connect(1)).rejects.toBe(
        "Unsupported MQTT protocol version: 4.0. Supported versions: 3.1.1, 5.0"
      );

      expect(store.getConnectionStatus(1)).toBe("error");
      expect(store.getConnectionError(1)).toBe(
        "Unsupported MQTT protocol version: 4.0. Supported versions: 3.1.1, 5.0"
      );
    });

    it("保存重连进度和最近错误且保留活跃订阅状态", async () => {
      const store = useMqttStore();
      await store.initListeners();
      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "sensor/+",
          operation: "subscribe",
          status: "active",
          requested_qos: 1,
          granted_qos: 1,
          operation_id: "op-active",
        },
      });

      connectionStateListener!({
        payload: {
          server_id: 1,
          status: "reconnecting",
          error: "Connection error: network unavailable",
          protocol_version: "5.0",
          capabilities: ["publish_properties", "session_expiry", "topic_alias"],
          reconnect_attempt: 3,
          retry_in_ms: 1750,
        },
      });

      expect(store.getConnectionStatus(1)).toBe("reconnecting");
      expect(store.getConnectionError(1)).toBe(
        "Connection error: network unavailable"
      );
      expect(store.getReconnectAttempt(1)).toBe(3);
      expect(store.getRetryInMs(1)).toBe(1750);
      expect(store.getSubscriptionState(1, "sensor/+")?.status).toBe("active");
    });
  });

  describe("订阅运行状态", () => {
    it("仅在 Broker ACK 事件到达后标记 active 并保存授予 QoS", async () => {
      const store = useMqttStore();
      await store.initListeners();
      mockedInvoke.mockResolvedValueOnce({
        operation_id: "op-1",
        granted_qos: 1,
      });

      await store.subscribe(1, "sensor/+", 2);

      expect(store.getSubscriptionState(1, "sensor/+")).toBeUndefined();

      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "sensor/+",
          operation: "subscribe",
          status: "active",
          requested_qos: 2,
          granted_qos: 1,
          operation_id: "op-1",
        },
      });

      expect(store.getSubscriptionState(1, "sensor/+")).toEqual({
        server_id: 1,
        topic: "sensor/+",
        operation: "subscribe",
        status: "active",
        requested_qos: 2,
        granted_qos: 1,
        operation_id: "op-1",
      });
    });

    it("保留 pending 到 failed 的错误状态", async () => {
      const store = useMqttStore();
      await store.initListeners();

      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "sensor/+",
          operation: "subscribe",
          status: "pending",
          requested_qos: 1,
          operation_id: "op-2",
        },
      });
      expect(store.getSubscriptionState(1, "sensor/+")?.status).toBe("pending");

      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "sensor/+",
          operation: "subscribe",
          status: "failed",
          requested_qos: 1,
          error: "Subscription acknowledgement timed out",
          operation_id: "op-2",
        },
      });

      expect(store.getSubscriptionState(1, "sensor/+")).toMatchObject({
        status: "failed",
        error: "Subscription acknowledgement timed out",
        operation_id: "op-2",
      });
      expect(ElMessage.error).toHaveBeenCalledWith({
        message: "errors.subscribeFailedDetail",
        duration: 8000,
        showClose: true,
      });
      expect(translate).toHaveBeenCalledWith("errors.subscribeFailedDetail", {
        topic: "sensor/+",
        qos: 1,
        reason: "Subscription acknowledgement timed out",
      });
    });

    it("订阅无权限时展示 Topic、QoS 和 ACL 建议而不是连接失败", async () => {
      const store = useMqttStore();
      await store.initListeners();

      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "#",
          operation: "subscribe",
          status: "failed",
          requested_qos: 0,
          error: "Broker rejected subscription: [NotAuthorized]",
          operation_id: "op-not-authorized",
        },
      });

      expect(store.getConnectionStatus(1)).toBe("disconnected");
      expect(translate).toHaveBeenCalledWith(
        "errors.subscriptionNotAuthorized",
        { topic: "#", qos: 0 }
      );
      expect(translate).not.toHaveBeenCalledWith("errors.connectFailed");
      expect(ElMessage.error).toHaveBeenCalledWith({
        message: "errors.subscriptionNotAuthorized",
        duration: 8000,
        showClose: true,
      });
    });

    it("断线后清除 active 并将 pending 标记为 failed", async () => {
      const store = useMqttStore();
      await store.initListeners();

      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "active/topic",
          operation: "subscribe",
          status: "active",
          requested_qos: 1,
          granted_qos: 1,
          operation_id: "op-active",
        },
      });
      subscriptionStateListener!({
        payload: {
          server_id: 1,
          topic: "pending/topic",
          operation: "subscribe",
          status: "pending",
          requested_qos: 2,
          operation_id: "op-pending",
        },
      });

      connectionStateListener!({
        payload: {
          server_id: 1,
          status: "disconnected",
        },
      });

      expect(store.getSubscriptionState(1, "active/topic")?.status).toBe("disabled");
      expect(store.getSubscriptionState(1, "active/topic")?.granted_qos).toBeUndefined();
      expect(store.getSubscriptionState(1, "pending/topic")).toMatchObject({
        status: "failed",
        error: "Connection closed before acknowledgement",
      });
    });
  });

  describe("发布确认状态", () => {
    it("立即插入 pending 并按 operation ID 原地更新到 confirmed", async () => {
      const store = useMqttStore();
      await store.initListeners();
      let resolvePublish!: (value: any) => void;
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === "publish_message") {
          return new Promise((resolve) => {
            resolvePublish = resolve;
          });
        }
        return Promise.resolve([]);
      });

      const publishPromise = store.publishTrackedMessage(1, {
        topic: "devices/1",
        payload: "on",
        qos: 1,
        retain: false,
        format: "text",
      });

      const pending = store.getServerMessages(1);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        topic: "devices/1",
        publish_status: "pending",
      });
      expect(pending[0].operation_id).toBeTruthy();

      publishStateListener!({
        payload: {
          operation_id: pending[0].operation_id,
          server_id: 1,
          qos: 1,
          status: "sent",
          packet_id: 41,
        },
      });
      expect(store.getServerMessages(1)).toHaveLength(1);
      expect(store.getServerMessages(1)[0]).toMatchObject({
        publish_status: "sent",
        packet_id: 41,
      });

      resolvePublish({
        id: 9,
        server_id: 1,
        direction: "publish",
        topic: "devices/1",
        payload: "on",
        payload_format: "text",
        qos: 1,
        retain: false,
        created_at: "2026-09-04T00:00:00Z",
        operation_id: pending[0].operation_id,
        publish_status: "confirmed",
        packet_id: 41,
        sent_at: "2026-09-04T00:00:01Z",
        confirmed_at: "2026-09-04T00:00:02Z",
      });
      await publishPromise;

      expect(store.getServerMessages(1)).toHaveLength(1);
      expect(store.getServerMessages(1)[0]).toMatchObject({
        id: 9,
        publish_status: "confirmed",
        packet_id: 41,
      });
    });

    it("Base64 发布使用同一组原始字节更新 pending 并调用后端", async () => {
      const store = useMqttStore();
      mockedInvoke.mockResolvedValue({
        id: 10,
        server_id: 1,
        direction: "publish",
        topic: "binary/topic",
        payload: "AP+AQQo=",
        payload_format: "base64",
        qos: 0,
        retain: false,
        publish_status: "sent",
      });

      const publishPromise = store.publishTrackedMessage(1, {
        topic: "binary/topic",
        payload: " AP+A\nQQo ",
        qos: 0,
        retain: false,
        format: "base64",
      });

      expect(Array.from(store.getServerMessages(1)[0].payload ?? [])).toEqual([
        0x00, 0xff, 0x80, 0x41, 0x0a,
      ]);

      await publishPromise;

      expect(mockedInvoke).toHaveBeenCalledWith("publish_message", {
        serverId: 1,
        message: expect.objectContaining({
          topic: "binary/topic",
          payload: " AP+A\nQQo ",
          payload_bytes: [0x00, 0xff, 0x80, 0x41, 0x0a],
          format: "base64",
        }),
      });
    });

    it("非法 Base64 在创建 pending 或调用后端前失败", async () => {
      const store = useMqttStore();

      await expect(
        store.publishTrackedMessage(1, {
          topic: "binary/topic",
          payload: "TQ=",
          qos: 0,
          retain: false,
          format: "base64",
        })
      ).rejects.toThrow("Invalid BASE64 payload");

      expect(store.getServerMessages(1)).toEqual([]);
      expect(mockedInvoke).not.toHaveBeenCalled();
    });
  });

  describe("queueMessage seq", () => {
    it("应为每条消息分配单调递增的 seq", async () => {
      const store = useMqttStore();

      // addPublishMessage 内部调用 queueMessage
      store.addPublishMessage(1, {
        topic: "t1",
        payload: "a",
        qos: 0,
        retain: false,
      });
      store.addPublishMessage(1, {
        topic: "t2",
        payload: "b",
        qos: 0,
        retain: false,
      });
      store.addPublishMessage(1, {
        topic: "t3",
        payload: "c",
        qos: 0,
        retain: false,
      });

      // 快进 batch timeout
      vi.advanceTimersByTime(100);

      const messages = store.getServerMessages(1);
      expect(messages).toHaveLength(3);
      expect(messages[0].seq).toBe(0);
      expect(messages[1].seq).toBe(1);
      expect(messages[2].seq).toBe(2);
    });

    it("不同 server 的消息 seq 仍单调递增", async () => {
      const store = useMqttStore();

      store.addPublishMessage(1, { topic: "s1", payload: "a", qos: 0, retain: false });
      store.addPublishMessage(2, { topic: "s2", payload: "b", qos: 0, retain: false });
      store.addPublishMessage(1, { topic: "s3", payload: "c", qos: 0, retain: false });

      vi.advanceTimersByTime(100);

      const messages1 = store.getServerMessages(1);
      const messages2 = store.getServerMessages(2);

      expect(messages1[0].seq).toBe(0);
      expect(messages2[0].seq).toBe(1);
      expect(messages1[1].seq).toBe(2);
    });
  });

  describe("flushMessageQueue 排序", () => {
    it("应按 seq 排序后合并，不受入队顺序影响", async () => {
      const store = useMqttStore();
      await store.initListeners();

      // 模拟脚本缓存：第一次调用（消息A）延迟，第二次（消息B）立即返回
      let scriptCallCount = 0;
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_enabled_scripts") {
          scriptCallCount++;
          if (scriptCallCount === 1) {
            // 消息A的脚本查询延迟两个微任务，让消息B先完成
            await Promise.resolve();
            await Promise.resolve();
          }
          return [];
        }
        return [];
      });

      // 同时触发两条接收消息（A先，B后）
      const msgA = {
        server_id: 1,
        topic: "topic/A",
        payload: [65],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:00Z",
      };
      const msgB = {
        server_id: 1,
        topic: "topic/B",
        payload: [66],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:01Z",
      };

      const p1 = mqttMessageListener!({ payload: msgA });
      const p2 = mqttMessageListener!({ payload: msgB });

      await Promise.all([p1, p2]);

      // 快进 batch timeout
      vi.advanceTimersByTime(100);

      const messages = store.getServerMessages(1);
      expect(messages.map((m) => m.topic)).toEqual(["topic/A", "topic/B"]);
    });

    it("发布与接收交错时应按触发顺序排序", async () => {
      const store = useMqttStore();
      await store.initListeners();

      // mock publish 延迟，模拟发布时的 await
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "publish_message") {
          await Promise.resolve();
          await Promise.resolve();
          return {
            server_id: 1,
            direction: "publish",
            topic: "topic/pub",
            payload: "payload",
            payload_format: "text",
            qos: 0,
            retain: false,
            publish_status: "sent",
          };
        }
        if (cmd === "get_enabled_scripts") {
          return [];
        }
        return [];
      });

      // 开始发布（内部会 await publish_message，期间让出控制权）
      const publishPromise = store.publishTrackedMessage(1, {
        topic: "topic/pub",
        payload: "payload",
        qos: 0,
        retain: false,
        format: "text",
      });

      // 在 publish 的 await 期间，模拟收到一条消息
      // 由于 publish 中的 await 会挂起，此时可以触发 listener
      const msgReceive = {
        server_id: 1,
        topic: "topic/recv",
        payload: [82],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:00Z",
      };

      const recvPromise = mqttMessageListener!({ payload: msgReceive });

      await Promise.all([publishPromise, recvPromise]);

      // 快进 batch timeout
      vi.advanceTimersByTime(100);

      const messages = store.getServerMessages(1);
      // publish 先触发，receive 后触发，所以 publish 应排在前面
      expect(messages[0].topic).toBe("topic/pub");
      expect(messages[1].topic).toBe("topic/recv");
    });

    it("预分配 seq 后 await，期间接收消息到达，发布仍排在前面", async () => {
      const store = useMqttStore();
      await store.initListeners();

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_enabled_scripts") {
          return [];
        }
        return [];
      });

      // 1. 预分配 seq（模拟 PublishPanel.vue 中 await 之前的 reserveSeq）
      const seq = store.reserveSeq();

      // 2. await 期间收到消息（模拟 await messageStore.publishMessage 期间）
      const msgReceive = {
        server_id: 1,
        topic: "topic/recv",
        payload: [82],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:00Z",
      };
      const recvPromise = mqttMessageListener!({ payload: msgReceive });
      await recvPromise;

      // 3. await 完成后用预分配的 seq 调用 addPublishMessage
      // （模拟 PublishPanel.vue 中 mqttStore.addPublishMessage）
      store.addPublishMessage(1, {
        topic: "topic/pub",
        payload: "payload",
        qos: 0,
        retain: false,
        seq,
      });

      // 快进 batch timeout
      vi.advanceTimersByTime(100);

      const messages = store.getServerMessages(1);
      // 预分配的 seq 更小，所以发布消息应排在前面
      expect(messages[0].topic).toBe("topic/pub");
      expect(messages[0].seq).toBe(seq);
      expect(messages[1].topic).toBe("topic/recv");
      expect(messages[1].seq).toBeGreaterThan(seq);
    });

    it("跨 batch 时仍应按 seq 全局排序", async () => {
      const store = useMqttStore();
      await store.initListeners();

      // mock：第一次调用延迟（A 的处理），第二次立即返回（B 的处理）
      let callCount = 0;
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_enabled_scripts") {
          callCount++;
          if (callCount === 1) {
            // A 的脚本查询延迟两个微任务
            await Promise.resolve();
            await Promise.resolve();
          }
          return [];
        }
        return [];
      });

      // 1. 同时触发 A 和 B（A 先触发但处理慢，B 后触发但处理快）
      const msgA = {
        server_id: 1,
        topic: "topic/A",
        payload: [65],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:00Z",
      };
      const msgB = {
        server_id: 1,
        topic: "topic/B",
        payload: [66],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:01Z",
      };

      const pA = mqttMessageListener!({ payload: msgA });
      const pB = mqttMessageListener!({ payload: msgB });

      // B 会在 A 挂起期间先完成 queueMessage
      await Promise.all([pA, pB]);

      // 2. 快进 batch timeout，A 和 B 在同一个 batch 中被 flush
      vi.advanceTimersByTime(100);

      const messages = store.getServerMessages(1);
      // A 先触发（seq 更小），虽然后到，但应排在 B 前面
      expect(messages[0].topic).toBe("topic/A");
      expect(messages[1].topic).toBe("topic/B");

      // 3. 再触发 C（seq 更大），让它在下一个 batch 中 flush
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_enabled_scripts") return [];
        return [];
      });

      const msgC = {
        server_id: 1,
        topic: "topic/C",
        payload: [67],
        qos: 0,
        retain: false,
        timestamp: "2024-01-01T00:00:02Z",
      };
      const pC = mqttMessageListener!({ payload: msgC });
      await pC;

      // 4. 快进 batch timeout，C 在新的 batch 中被 flush
      vi.advanceTimersByTime(100);

      const messages2 = store.getServerMessages(1);
      // 全局排序：A(seq 最小) < B(seq 中等) < C(seq 最大)
      expect(messages2.map((m) => m.topic)).toEqual(["topic/A", "topic/B", "topic/C"]);
    });
  });

  describe("累计接收计数", () => {
    it("达到保留上限后仍应继续累计接收数", async () => {
      const store = useMqttStore();
      await store.initListeners();

      for (let i = 0; i < 1002; i++) {
        await mqttMessageListener!({
          payload: {
            server_id: 1,
            topic: `topic/${i}`,
            payload: [65],
            qos: 0,
            retain: false,
            timestamp: `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
          },
        });
      }

      vi.advanceTimersByTime(100);

      expect(store.getServerMessages(1)).toHaveLength(1000);
      expect(store.getReceivedCount(1)).toBe(1002);
    });
  });

  describe("batch receive production listener", () => {
    const message = (seq: number, server_id = 1, payload = [0, 255, 128, 65]) => ({
      server_id, seq: String(seq), topic: `receive/${seq}`, payload, qos: 2, retain: true,
      timestamp: "2026-10-09T00:00:00Z",
    });
    function deliver(messages: ReturnType<typeof message>[]) {
      mqttBatchListener!({ payload: { messages, dropped_total: 0, emit_failures_total: 0 } });
    }

    it("orders interleaved servers and batches with slow scripts and shared publish seq", async () => {
      const store = useMqttStore();
      await store.initListeners();
      mockedInvoke.mockImplementation(async command => command === "get_enabled_scripts" ? [{ code: "test" }] : []);
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      vi.mocked(ScriptEngine.executeAfterReceive).mockImplementationOnce(async (_scripts, payload) => {
        started(); await new Promise<void>(resolve => { release = resolve; }); return payload;
      });
      deliver([message(1, 2, [66]), message(0, 1, [65])]);
      const flushing = store.flushReceiveQueue();
      await ready;
      const publishSeq = store.reserveSeq();
      store.addPublishMessage(1, { topic: "publish", payload: "P", qos: 0, retain: false, seq: publishSeq });
      deliver([message(2, 1, [67])]);
      expect(ScriptEngine.executeAfterReceive).toHaveBeenCalledTimes(1);
      release();
      await flushing;
      expect(store.getServerMessages(1).map(message => message.topic)).toEqual(["receive/0", "publish", "receive/2"]);
      expect(store.getServerMessages(2)[0].seq).toBe(1);
      expect(store.getServerMessages(1).map(message => message.seq)).toEqual([0, 2, 3]);
    });

    it("keeps binary bytes and saves history once per batch with ids and explicit format/time", async () => {
      const store = useMqttStore();
      await store.initListeners();
      mockedInvoke.mockImplementation(async (command, args: any) => command === "save_received_messages"
        ? args.messages.map((_row: any, index: number) => index + 100) : []);
      deliver([message(0), message(1, 2)]);
      await store.flushReceiveQueue();
      expect(store.getServerMessages(1)[0]).toMatchObject({ id: 100, payload: new Uint8Array([0, 255, 128, 65]), receive_seq: "0" });
      const saves = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "save_received_messages");
      expect(saves).toHaveLength(1);
      expect(saves[0][1]).toEqual({ messages: [1, 2].map(server_id => ({
        server_id, topic: `receive/${server_id - 1}`, payload: "00FF8041", payload_format: "hex", qos: 2, retain: true,
        timestamp: "2026-10-09T00:00:00Z",
      })) });
      expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === "save_received_message")).toBe(false);
    });

    it("protects binary bytes from a failed script and tolerates script/env cache load failures", async () => {
      const store = useMqttStore();
      await store.initListeners();
      mockedInvoke.mockImplementation(async command => {
        if (command === "get_enabled_scripts") return [{ code: "failure" }];
        if (command === "list_env_variables") throw new Error("env unavailable");
        return [];
      });
      vi.mocked(ScriptEngine.executeAfterReceive).mockImplementationOnce(async (_scripts, _payload, _topic, env, bytes) => {
        expect(env).toEqual({});
        bytes![0] = 42;
        throw new Error("failed transform");
      });
      deliver([message(0)]);
      await store.flushReceiveQueue();
      expect(store.getServerMessages(1)[0]).toMatchObject({ payload: new Uint8Array([0, 255, 128, 65]), scriptError: "failed transform" });
      expect(mockedInvoke).toHaveBeenCalledWith("save_received_messages", { messages: [expect.objectContaining({ payload: "00FF8041", payload_format: "hex" })] });
      clearScriptCache();
      mockedInvoke.mockImplementation(async command => {
        if (command === "get_enabled_scripts") throw new Error("scripts unavailable");
        return [];
      });
      deliver([message(1)]);
      await store.flushReceiveQueue();
      expect(store.getServerMessages(1)[1]).toMatchObject({ payload: new Uint8Array([0, 255, 128, 65]) });
      expect(ScriptEngine.executeAfterReceive).toHaveBeenCalledTimes(1);
    });

    it("drops newest at the hard item cap including persistence in flight and throttles notices", async () => {
      const store = useMqttStore();
      await store.initListeners();
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      mockedInvoke.mockImplementation(async command => {
        if (command === "save_received_messages") { started(); await new Promise<void>(resolve => { release = resolve; }); }
        return [];
      });
      deliver(Array.from({ length: 128 }, (_, i) => message(i)));
      await ready;
      deliver(Array.from({ length: RECEIVE_LIMITS.count }, (_, i) => message(i + 128)));
      expect(store.receiveStats).toMatchObject({ pendingCount: 2048, peakCount: 2048, dropped: 128 });
      expect(ElMessage.error).toHaveBeenCalledTimes(1);
      mockedInvoke.mockResolvedValue([]);
      release();
      await store.flushReceiveQueue();
      expect(store.receiveStats.pendingCount).toBe(0);
      expect(store.getReceivedCount(1)).toBe(2176);
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "save_received_messages")).toHaveLength(16);
      expect(store.getServerMessages(1).at(-1)?.receive_seq).toBe("2047");
    });

    it("enforces the byte budget before conversion and continues after persistence and display failures", async () => {
      const store = useMqttStore();
      await store.initListeners();
      deliver([message(0, 1, new Array(RECEIVE_LIMITS.bytes / 8).fill(255)), message(1)]);
      vi.advanceTimersByTime(5000);
      mockedInvoke.mockImplementation(async command => { if (command === "save_received_messages") throw new Error("sqlite busy"); return []; });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dispatch = vi.spyOn(window, "dispatchEvent").mockImplementationOnce(() => { throw new Error("observer failed"); });
      await store.flushReceiveQueue();
      expect(store.receiveStats).toMatchObject({ dropped: 1, failures: 2, pendingCount: 0, pendingBytes: 0 });
      mockedInvoke.mockResolvedValue([]);
      deliver([message(2)]);
      await store.flushReceiveQueue();
      expect(store.getServerMessages(1).map(message => message.receive_seq)).toEqual(["1", "2"]);
      expect(warning).toHaveBeenCalledTimes(1);
      dispatch.mockRestore(); warning.mockRestore();
    });
  });
});
