import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { MessageHistory, PublishPayload } from "@/types/mqtt";
import { useAppStore } from "@/stores/app";

export const useMessageStore = defineStore("message", () => {
  const appStore = useAppStore();
  const messages = ref<Map<number, MessageHistory[]>>(new Map());
  const realtimeMessages = ref<Map<number, MessageHistory[]>>(new Map());
  const loading = ref(false);
  const loadingMore = ref(false);
  const hasMoreHistory = ref<Map<number, boolean>>(new Map());

  function setHasMoreHistory(serverId: number, value: boolean) {
    const nextMap = new Map(hasMoreHistory.value);
    nextMap.set(serverId, value);
    hasMoreHistory.value = nextMap;
  }

  function getEffectivePageLimit(limit: number) {
    return Math.min(limit, appStore.messageLimit);
  }

  async function fetchMessageHistory(serverId: number, limit = 100) {
    loading.value = true;
    try {
      const effectiveLimit = getEffectivePageLimit(limit);
      const result = await invoke<MessageHistory[]>("get_message_history", {
        serverId,
        limit: effectiveLimit,
        offset: 0,
      });
      messages.value.set(serverId, [...result].reverse());
      setHasMoreHistory(serverId, result.length === effectiveLimit && effectiveLimit < appStore.messageLimit);
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreMessageHistory(serverId: number, limit = 100) {
    if (loadingMore.value || !getHasMoreHistory(serverId)) return;

    loadingMore.value = true;
    try {
      const currentMessages = messages.value.get(serverId) || [];
      const remaining = appStore.messageLimit - currentMessages.length;
      if (remaining <= 0) {
        setHasMoreHistory(serverId, false);
        return;
      }

      const effectiveLimit = Math.min(limit, remaining);
      const result = await invoke<MessageHistory[]>("get_message_history", {
        serverId,
        limit: effectiveLimit,
        offset: currentMessages.length,
      });
      const merged = [...result].reverse().concat(currentMessages);
      messages.value.set(serverId, merged);
      setHasMoreHistory(
        serverId,
        result.length === effectiveLimit && currentMessages.length + result.length < appStore.messageLimit
      );
    } finally {
      loadingMore.value = false;
    }
  }

  async function fetchAllMessageHistory(serverId: number, pageSize = 500) {
    const allMessages: MessageHistory[] = [];
    let offset = 0;
    const effectivePageSize = Math.max(1, pageSize);

    while (true) {
      const result = await invoke<MessageHistory[]>("get_message_history", {
        serverId,
        limit: effectivePageSize,
        offset,
      });

      if (result.length === 0) break;

      allMessages.push(...result);
      offset += result.length;

      if (result.length < effectivePageSize) break;
    }

    return allMessages.reverse();
  }

  async function publishMessage(serverId: number, message: PublishPayload) {
    const result = await invoke<MessageHistory>("publish_message", {
      serverId,
      message,
    });

    // 添加到消息列表
    addMessage(serverId, result);

    return result;
  }

  function addMessage(serverId: number, message: MessageHistory) {
    const serverMessages = messages.value.get(serverId) || [];
    serverMessages.push(message);

    // 限制消息数量
    if (serverMessages.length > appStore.messageLimit) {
      serverMessages.shift();
    }

    messages.value.set(serverId, serverMessages);

    // 同时更新实时消息列表
    const realtimeMsgs = realtimeMessages.value.get(serverId) || [];
    realtimeMsgs.unshift(message);
    if (realtimeMsgs.length > appStore.messageLimit) {
      realtimeMsgs.pop();
    }
    realtimeMessages.value.set(serverId, realtimeMsgs);
  }

  async function clearHistory(serverId: number) {
    await invoke("clear_message_history", { serverId });
    messages.value.set(serverId, []);
    realtimeMessages.value.set(serverId, []);
    setHasMoreHistory(serverId, false);
  }

  function getMessages(serverId: number) {
    return messages.value.get(serverId) || [];
  }

  function getRealtimeMessages(serverId: number) {
    return realtimeMessages.value.get(serverId) || [];
  }

  function getHasMoreHistory(serverId: number) {
    return hasMoreHistory.value.get(serverId) ?? false;
  }

  function applyMessageLimit() {
    const limit = appStore.messageLimit;
    const nextMessages = new Map<number, MessageHistory[]>();
    const nextRealtimeMessages = new Map<number, MessageHistory[]>();
    for (const [serverId, serverMessages] of messages.value.entries()) {
      nextMessages.set(
        serverId,
        serverMessages.length > limit ? serverMessages.slice(-limit) : serverMessages
      );
      setHasMoreHistory(
        serverId,
        (nextMessages.get(serverId)?.length ?? 0) >= limit ? false : getHasMoreHistory(serverId)
      );
    }
    for (const [serverId, serverMessages] of realtimeMessages.value.entries()) {
      nextRealtimeMessages.set(
        serverId,
        serverMessages.length > limit ? serverMessages.slice(0, limit) : serverMessages
      );
    }
    messages.value = nextMessages;
    realtimeMessages.value = nextRealtimeMessages;
  }

  return {
    messages,
    realtimeMessages,
    loading,
    loadingMore,
    hasMoreHistory,
    fetchMessageHistory,
    loadMoreMessageHistory,
    fetchAllMessageHistory,
    publishMessage,
    addMessage,
    clearHistory,
    getMessages,
    getRealtimeMessages,
    getHasMoreHistory,
    applyMessageLimit,
  };
});
