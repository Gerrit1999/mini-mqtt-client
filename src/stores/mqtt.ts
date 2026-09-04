import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessage } from "element-plus";
import type {
  ConnectionStatus,
  EnvVariable,
  MqttCapability,
  MqttMessage,
  MqttProtocolVersion,
  SubscriptionOperationResult,
  SubscriptionRuntimeState,
} from "@/types/mqtt";
import { ScriptEngine } from "@/utils/scriptEngine";
import type { Script } from "@/stores/script";
import { handleScriptError } from "@/utils/errorHandler";
import i18n from "@/i18n";
import { useAppStore } from "@/stores/app";

interface ConnectionState {
  server_id: number;
  status: ConnectionStatus;
  error?: string;
  protocol_version?: MqttProtocolVersion;
  capabilities?: MqttCapability[];
}

interface ReceivedMessage {
  server_id: number;
  topic: string;
  payload: number[];
  qos: number;
  retain: boolean;
  timestamp: string;
}

  // 脚本缓存接口
interface ScriptCache {
  scripts: Script[];
  timestamp: number;
}

// 环境变量缓存接口
interface EnvCache {
  variables: Record<string, string>;
  timestamp: number;
}

type StoredPayloadFormat = "json" | "text" | "hex";

// 脚本缓存有效期（毫秒）
const SCRIPT_CACHE_TTL = 5000;

export const useMqttStore = defineStore("mqtt", () => {
  const appStore = useAppStore();
  const textEncoder = new TextEncoder();
  const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
  // 连接状态
  const connectionStates = ref<
    Map<
      number,
      {
        status: ConnectionStatus;
        error?: string;
        protocolVersion?: MqttProtocolVersion;
        capabilities: MqttCapability[];
      }
    >
  >(new Map());

  // 按 serverId 分组存储消息（使用 shallowRef 减少深度响应式开销）
  const messagesByServer = shallowRef<Map<number, MqttMessage[]>>(new Map());

  // 每个 server 的累计接收计数（不受消息保留上限影响）
  const receivedCountByServer = ref<Map<number, number>>(new Map());

  // Broker 确认的连接级订阅运行状态（按 server_id 和 topic 分组）
  const subscriptionStates = ref<
    Map<number, Map<string, SubscriptionRuntimeState>>
  >(new Map());

  // 脚本缓存（避免高频调用 invoke）
  const scriptCache = new Map<string, ScriptCache>();

  // 环境变量缓存
  const envCache = new Map<number, EnvCache>();

  // 消息批处理队列
  const messageQueue: MqttMessage[] = [];
  let batchTimeout: ReturnType<typeof setTimeout> | null = null;
  const BATCH_INTERVAL = 50; // 批处理间隔（毫秒）

  // 单调递增序列号，保证消息顺序
  let nextSeq = 0;

  // 获取缓存的脚本
  async function getCachedScripts(serverId: number, scriptType: string): Promise<Script[]> {
    const cacheKey = `${serverId}-${scriptType}`;
    const cached = scriptCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < SCRIPT_CACHE_TTL) {
      return cached.scripts;
    }

    try {
      const scripts = await invoke<Script[]>("get_enabled_scripts", {
        serverId,
        scriptType,
      });
      scriptCache.set(cacheKey, { scripts, timestamp: now });
      return scripts;
    } catch {
      return [];
    }
  }

  // 清除脚本缓存（当脚本更新时调用）
  function clearScriptCache(serverId?: number) {
    if (serverId) {
      scriptCache.delete(`${serverId}-before_send`);
      scriptCache.delete(`${serverId}-after_receive`);
    } else {
      scriptCache.clear();
    }
  }

  // 获取缓存的环境变量
  async function getCachedEnvVariables(serverId: number): Promise<Record<string, string>> {
    const cached = envCache.get(serverId);
    const now = Date.now();

    if (cached && now - cached.timestamp < SCRIPT_CACHE_TTL) {
      return cached.variables;
    }

    try {
      const envList = await invoke<EnvVariable[]>("list_env_variables", { serverId });
      const variables: Record<string, string> = {};
      for (const env of envList) {
        variables[env.name] = env.value;
      }
      envCache.set(serverId, { variables, timestamp: now });
      return variables;
    } catch {
      return {};
    }
  }

  // 清除环境变量缓存
  function clearEnvCache(serverId?: number) {
    if (serverId) {
      envCache.delete(serverId);
    } else {
      envCache.clear();
    }
  }

  function incrementReceivedCount(serverId: number, amount: number = 1) {
    const nextMap = new Map(receivedCountByServer.value);
    nextMap.set(serverId, (nextMap.get(serverId) ?? 0) + amount);
    receivedCountByServer.value = nextMap;
  }

  function bytesToHex(payload: Uint8Array): string {
    return Array.from(payload)
      .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
      .join("");
  }

  function detectStoredPayloadFormat(
    payloadBytes: Uint8Array
  ): { payload: string; format: StoredPayloadFormat } {
    if (payloadBytes.length === 0) {
      return { payload: "", format: "text" };
    }

    let decoded: string | null = null;
    try {
      decoded = strictTextDecoder.decode(payloadBytes);
    } catch {
      decoded = null;
    }

    if (decoded !== null) {
      let nonPrintableCount = 0;
      for (const byte of payloadBytes) {
        if ((byte < 32 || byte > 126) && byte !== 9 && byte !== 10 && byte !== 13) {
          nonPrintableCount++;
        }
      }

      if (nonPrintableCount / payloadBytes.length > 0.1) {
        return { payload: bytesToHex(payloadBytes), format: "hex" };
      }

      const trimmed = decoded.trim();
      if (
        trimmed &&
        ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]")))
      ) {
        try {
          JSON.parse(trimmed);
          return { payload: decoded, format: "json" };
        } catch {
          // fall through to plain text
        }
      }

      return { payload: decoded, format: "text" };
    }

    return { payload: bytesToHex(payloadBytes), format: "hex" };
  }

  // 批量处理消息队列
  function flushMessageQueue() {
    if (messageQueue.length === 0) return;

    const newMap = new Map(messagesByServer.value);

    // 按 serverId 分组处理
    const messagesByServerId = new Map<number, MqttMessage[]>();
    for (const msg of messageQueue) {
      if (!messagesByServerId.has(msg.server_id)) {
        messagesByServerId.set(msg.server_id, []);
      }
      messagesByServerId.get(msg.server_id)!.push(msg);
    }

    // 合并到现有消息（新消息与已有消息一起按 seq 全局排序）
    for (const [serverId, newMessages] of messagesByServerId) {
      const existing = newMap.get(serverId) || [];
      const merged = existing.concat(newMessages);
      merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const messageLimit = appStore.messageLimit;
      // 限制每个 server 的消息数量
      newMap.set(
        serverId,
        merged.length > messageLimit ? merged.slice(-messageLimit) : merged
      );
    }

    messagesByServer.value = newMap;
    messageQueue.length = 0;
    batchTimeout = null;

    // 派发事件通知消息列表已更新（供 MessageList.vue 自动滚动使用）
    const serverIds = Array.from(messagesByServerId.keys());
    if (typeof window !== "undefined" && serverIds.length > 0) {
      window.dispatchEvent(
        new CustomEvent("mqtt-messages-flushed", { detail: { serverIds } })
      );
    }
  }

  // 添加消息到队列（未指定 seq 时自动分配）
  function queueMessage(msg: MqttMessage) {
    if (msg.seq === undefined) {
      msg = { ...msg, seq: nextSeq++ };
    }
    messageQueue.push(msg);

    if (!batchTimeout) {
      batchTimeout = setTimeout(flushMessageQueue, BATCH_INTERVAL);
    }
  }

  // 初始化事件监听
  const initListeners = async () => {
    // 监听连接状态变化
    await listen<ConnectionState>("mqtt-connection-state", (event) => {
      const { server_id, status, error, protocol_version, capabilities } = event.payload;
      connectionStates.value.set(server_id, {
        status: status as ConnectionStatus,
        error,
        protocolVersion: protocol_version,
        capabilities: capabilities ?? [],
      });

      if (status === "disconnected" || status === "error") {
        const existingStates = subscriptionStates.value.get(server_id);
        if (existingStates) {
          const nextStates = new Map(subscriptionStates.value);
          const serverStates = new Map(existingStates);
          for (const [topic, state] of serverStates) {
            if (state.status === "active") {
              serverStates.set(topic, {
                ...state,
                status: "disabled",
                granted_qos: undefined,
                error: undefined,
              });
            } else if (state.status === "pending") {
              serverStates.set(topic, {
                ...state,
                status: "failed",
                granted_qos: undefined,
                error: error ?? "Connection closed before acknowledgement",
              });
            }
          }
          nextStates.set(server_id, serverStates);
          subscriptionStates.value = nextStates;
        }
      }
      
      // 如果有错误，使用 ElMessage 显示
      if (error && status === "error") {
        ElMessage.error({
          message: `${i18n.global.t('errors.connectFailed')}: ${error}`,
          duration: 5000,
        });
      }
    });

    await listen<SubscriptionRuntimeState>("mqtt-subscription-state", (event) => {
      const state = event.payload;
      const nextStates = new Map(subscriptionStates.value);
      const serverStates = new Map(nextStates.get(state.server_id) ?? []);
      serverStates.set(state.topic, state);
      nextStates.set(state.server_id, serverStates);
      subscriptionStates.value = nextStates;

      if (state.status === "failed" && state.error) {
        const errorKey =
          state.operation === "unsubscribe"
            ? "errors.unsubscribeFailed"
            : "errors.subscribeFailed";
        ElMessage.error({
          message: `${i18n.global.t(errorKey)}: ${state.error}`,
          duration: 5000,
        });
      }
    });

    // 监听接收消息
    await listen<ReceivedMessage>("mqtt-message", async (event) => {
      const msg = event.payload;
      const seq = nextSeq++; // 在异步处理前分配序列号
      incrementReceivedCount(msg.server_id);
      let payloadBytes = new Uint8Array(msg.payload);
      let scriptError: string | undefined = undefined;

      // 尝试应用接收后处理脚本（使用缓存）
      try {
        const scripts = await getCachedScripts(msg.server_id, "after_receive");

        if (scripts.length > 0) {
          const originalPayloadBytes = new Uint8Array(payloadBytes);
          const originalPayload = new TextDecoder().decode(payloadBytes);
          const envVariables = await getCachedEnvVariables(msg.server_id);
          const processedPayload = await ScriptEngine.executeAfterReceive(
            scripts,
            originalPayload,
            msg.topic,
            envVariables,
            originalPayloadBytes
          );
          payloadBytes = new TextEncoder().encode(processedPayload);
        }
      } catch (error: any) {
        // 记录脚本错误
        scriptError = error?.message || String(error);
        handleScriptError(error, true); // 静默处理，不显示通知（会写入日志）
      }

      // 使用批处理队列
      queueMessage({
        server_id: msg.server_id,
        direction: "receive",
        topic: msg.topic,
        payload: payloadBytes,
        qos: msg.qos as 0 | 1 | 2,
        retain: msg.retain,
        timestamp: msg.timestamp,
        scriptError: scriptError,
        seq,
      });

      const storedMessage = detectStoredPayloadFormat(payloadBytes);
      try {
        await invoke("save_received_message", {
          serverId: msg.server_id,
          topic: msg.topic,
          payload: storedMessage.payload,
          payloadFormat: storedMessage.format,
          qos: msg.qos,
          retain: msg.retain,
          timestamp: msg.timestamp,
        });
      } catch (error) {
        console.warn("Failed to persist received message:", error);
      }
    });
  };

  // 连接
  const connect = async (serverId: number) => {
    connectionStates.value.set(serverId, {
      status: "connecting",
      error: undefined,
      capabilities: [],
    });
    try {
      await invoke("mqtt_connect", { serverId });
    } catch (error) {
      connectionStates.value.set(serverId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        capabilities: [],
      });
      throw error;
    }
  };

  // 断开连接
  const disconnect = async (serverId: number) => {
    await invoke("mqtt_disconnect", { serverId });
  };

  // 发布消息
  const publish = async (
    serverId: number,
    topic: string,
    payload: string | Uint8Array,
    qos: 0 | 1 | 2 = 0,
    retain: boolean = false
  ) => {
    const seq = nextSeq++; // 在异步调用前分配序列号
    const payloadBytes =
      typeof payload === "string"
        ? Array.from(textEncoder.encode(payload))
        : Array.from(payload);

    await invoke("mqtt_publish", {
      serverId,
      topic,
      payload: payloadBytes,
      qos,
      retain,
    });

    // 添加到消息列表（使用批处理）
    queueMessage({
      server_id: serverId,
      direction: "publish",
      topic,
      payload:
        typeof payload === "string" ? textEncoder.encode(payload) : payload,
      qos,
      retain,
      timestamp: new Date().toISOString(),
      seq,
    });
  };

  // 订阅
  const subscribe = async (
    serverId: number,
    topic: string,
    qos: 0 | 1 | 2 = 0
  ): Promise<SubscriptionOperationResult> =>
    invoke<SubscriptionOperationResult>("mqtt_subscribe", { serverId, topic, qos });

  // 取消订阅
  const unsubscribe = async (
    serverId: number,
    topic: string
  ): Promise<SubscriptionOperationResult> =>
    invoke<SubscriptionOperationResult>("mqtt_unsubscribe", { serverId, topic });

  const getSubscriptionState = (
    serverId: number,
    topic: string
  ): SubscriptionRuntimeState | undefined =>
    subscriptionStates.value.get(serverId)?.get(topic);

  // 获取连接状态
  const getConnectionStatus = (serverId: number): ConnectionStatus => {
    return connectionStates.value.get(serverId)?.status || "disconnected";
  };

  // 获取连接错误
  const getConnectionError = (serverId: number): string | undefined => {
    return connectionStates.value.get(serverId)?.error;
  };

  const getConnectionProtocolVersion = (
    serverId: number
  ): MqttProtocolVersion | undefined => {
    return connectionStates.value.get(serverId)?.protocolVersion;
  };

  const supportsCapability = (
    serverId: number,
    capability: MqttCapability
  ): boolean => {
    return connectionStates.value.get(serverId)?.capabilities.includes(capability) ?? false;
  };

  // 获取某个 server 的消息（直接返回，无需过滤）
  const getServerMessages = (serverId: number): MqttMessage[] => {
    return messagesByServer.value.get(serverId) || [];
  };

  const getReceivedCount = (serverId: number): number => {
    return receivedCountByServer.value.get(serverId) || 0;
  };

  const applyMessageLimit = () => {
    const limit = appStore.messageLimit;
    const newMap = new Map<number, MqttMessage[]>();
    for (const [serverId, serverMessages] of messagesByServer.value.entries()) {
      newMap.set(
        serverId,
        serverMessages.length > limit ? serverMessages.slice(-limit) : serverMessages
      );
    }
    messagesByServer.value = newMap;
  };

  // 清空消息
  const clearMessages = (serverId?: number) => {
    const newMap = new Map(messagesByServer.value);
    const newCountMap = new Map(receivedCountByServer.value);
    if (serverId) {
      newMap.delete(serverId);
      newCountMap.delete(serverId);
    } else {
      newMap.clear();
      newCountMap.clear();
    }
    messagesByServer.value = newMap;
    receivedCountByServer.value = newCountMap;
  };

  // 将 HEX 字符串转换为字节数组
  const hexToBytes = (hex: string): Uint8Array => {
    const cleanHex = hex.replace(/\s/g, "");
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
    }
    return bytes;
  };

  // 添加发布消息到列表（用于UI显示）
  const addPublishMessage = (
    serverId: number,
    msg: {
      id?: number;
      topic: string;
      payload: string;
      qos: 0 | 1 | 2;
      retain: boolean;
      scriptError?: string;
      payload_type?: "json" | "hex" | "text";
      timestamp?: string;
      seq?: number;
    }
  ) => {
    // 根据 payload_type 决定如何编码 payload
    let payloadBytes: Uint8Array;
    if (msg.payload_type === "hex") {
      // HEX 格式：将 HEX 字符串转换为实际字节
      payloadBytes = hexToBytes(msg.payload);
    } else {
      // 其他格式：直接用 TextEncoder 编码
      payloadBytes = textEncoder.encode(msg.payload);
    }

    // 使用批处理队列
    queueMessage({
      id: msg.id,
      server_id: serverId,
      direction: "publish",
      topic: msg.topic,
      payload: payloadBytes,
      qos: msg.qos,
      retain: msg.retain,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      scriptError: msg.scriptError,
      payload_type: msg.payload_type,
      seq: msg.seq,
    });
  };

  // 预分配序列号（用于异步操作前标记顺序）
  const reserveSeq = () => nextSeq++;

  return {
    connectionStates,
    messagesByServer,
    receivedCountByServer,
    subscriptionStates,
    initListeners,
    connect,
    disconnect,
    publish,
    subscribe,
    unsubscribe,
    getSubscriptionState,
    getConnectionStatus,
    getConnectionError,
    getConnectionProtocolVersion,
    supportsCapability,
    getServerMessages,
    getReceivedCount,
    applyMessageLimit,
    clearMessages,
    addPublishMessage,
    reserveSeq,
    clearScriptCache,
    clearEnvCache,
  };
});
