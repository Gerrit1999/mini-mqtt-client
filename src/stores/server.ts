import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { MqttServer, ConnectionStatus } from "@/types/mqtt";

const SERVER_SIDEBAR_CONFIG_KEY = "mqtt-client-server-sidebar";

// 运行时 Server 状态
export interface ServerState {
  server: MqttServer;
  status: ConnectionStatus;
  errorMessage?: string;
}

export interface ServerGroup {
  id: string;
  name: string;
  created_at: string;
}

interface ServerSidebarConfig {
  groups: ServerGroup[];
  assignments: Record<string, string>;
  collapsedGroupIds: string[];
}

export const useServerStore = defineStore("server", () => {
  // Server 列表
  const servers = ref<ServerState[]>([]);

  // 左侧分组
  const groups = ref<ServerGroup[]>([]);
  const groupAssignments = ref<Record<string, string>>({});
  const collapsedGroupIds = ref<string[]>([]);

  // 当前选中的 Server ID
  const activeServerId = ref<number | null>(null);

  // 加载状态
  const loading = ref(false);

  // 当前选中的 Server
  const activeServer = computed(() => {
    return servers.value.find((s) => s.server.id === activeServerId.value);
  });

  const loadSidebarConfig = () => {
    try {
      const raw = localStorage.getItem(SERVER_SIDEBAR_CONFIG_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as Partial<ServerSidebarConfig>;
      groups.value = Array.isArray(parsed.groups) ? parsed.groups : [];
      groupAssignments.value =
        parsed.assignments && typeof parsed.assignments === "object"
          ? parsed.assignments
          : {};
      collapsedGroupIds.value = Array.isArray(parsed.collapsedGroupIds)
        ? parsed.collapsedGroupIds
        : [];
    } catch (error) {
      console.warn("Failed to load server sidebar config:", error);
    }
  };

  const saveSidebarConfig = () => {
    const config: ServerSidebarConfig = {
      groups: groups.value,
      assignments: groupAssignments.value,
      collapsedGroupIds: collapsedGroupIds.value,
    };
    localStorage.setItem(SERVER_SIDEBAR_CONFIG_KEY, JSON.stringify(config));
  };

  const cleanupSidebarConfig = () => {
    const validServerIds = new Set(
      servers.value
        .map((serverState) => serverState.server.id)
        .filter((id): id is number => typeof id === "number")
    );
    const validGroupIds = new Set(groups.value.map((group) => group.id));

    const nextAssignments: Record<string, string> = {};
    for (const [serverId, groupId] of Object.entries(groupAssignments.value)) {
      if (validServerIds.has(Number(serverId)) && validGroupIds.has(groupId)) {
        nextAssignments[serverId] = groupId;
      }
    }

    groupAssignments.value = nextAssignments;
    collapsedGroupIds.value = collapsedGroupIds.value.filter((id) => validGroupIds.has(id));
    saveSidebarConfig();
  };

  const getGroupIdForServer = (serverId?: number | null): string | null => {
    if (!serverId) return null;
    const groupId = groupAssignments.value[String(serverId)];
    if (!groupId) return null;
    return groups.value.some((group) => group.id === groupId) ? groupId : null;
  };

  const assignServerToGroup = (serverId: number, groupId: string | null) => {
    if (groupId && groups.value.some((group) => group.id === groupId)) {
      groupAssignments.value[String(serverId)] = groupId;
    } else {
      delete groupAssignments.value[String(serverId)];
    }
    saveSidebarConfig();
  };

  const createGroup = (name: string): string => {
    const group: ServerGroup = {
      id: `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      created_at: new Date().toISOString(),
    };
    groups.value.unshift(group);
    saveSidebarConfig();
    return group.id;
  };

  const renameGroup = (groupId: string, name: string) => {
    const group = groups.value.find((item) => item.id === groupId);
    if (!group) return;
    group.name = name.trim();
    saveSidebarConfig();
  };

  const deleteGroup = (groupId: string) => {
    groups.value = groups.value.filter((group) => group.id !== groupId);

    for (const [serverId, assignedGroupId] of Object.entries(groupAssignments.value)) {
      if (assignedGroupId === groupId) {
        delete groupAssignments.value[serverId];
      }
    }

    collapsedGroupIds.value = collapsedGroupIds.value.filter((id) => id !== groupId);
    saveSidebarConfig();
  };

  const toggleGroupCollapsed = (groupId: string) => {
    if (collapsedGroupIds.value.includes(groupId)) {
      collapsedGroupIds.value = collapsedGroupIds.value.filter((id) => id !== groupId);
    } else {
      collapsedGroupIds.value = [...collapsedGroupIds.value, groupId];
    }
    saveSidebarConfig();
  };

  const isGroupCollapsed = (groupId: string): boolean => {
    return collapsedGroupIds.value.includes(groupId);
  };

  // 加载所有 Server
  const fetchServers = async () => {
    loading.value = true;
    try {
      const data = await invoke<MqttServer[]>("get_servers");
      servers.value = data.map((server) => ({
        server,
        status: "disconnected" as ConnectionStatus,
      }));
      cleanupSidebarConfig();
    } catch (e) {
      console.error("Failed to fetch servers:", e);
    } finally {
      loading.value = false;
    }
  };

  // 创建 Server
  const createServer = async (
    serverData: Omit<MqttServer, "id" | "created_at" | "updated_at">,
    groupId: string | null = null
  ): Promise<number> => {
    const id = await invoke<number>("create_server", { server: serverData });
    
    const now = new Date().toISOString();
    const server: MqttServer = {
      ...serverData,
      id,
      created_at: now,
      updated_at: now,
    };

    servers.value.unshift({
      server,
      status: "disconnected",
    });

    assignServerToGroup(id, groupId);
    if (!activeServerId.value) {
      activeServerId.value = id;
    }

    return id;
  };

  // 更新 Server
  const updateServer = async (serverData: MqttServer, groupId?: string | null) => {
    await invoke("update_server", { server: serverData });
    
    const index = servers.value.findIndex((s) => s.server.id === serverData.id);
    if (index !== -1) {
      servers.value[index].server = {
        ...serverData,
        updated_at: new Date().toISOString(),
      };
    }

    if (groupId !== undefined && serverData.id) {
      assignServerToGroup(serverData.id, groupId);
    }
  };

  // 删除 Server
  const removeServer = async (id: number) => {
    await invoke("delete_server", { id });
    
    const index = servers.value.findIndex((s) => s.server.id === id);
    if (index !== -1) {
      servers.value.splice(index, 1);
      delete groupAssignments.value[String(id)];
      saveSidebarConfig();
      if (activeServerId.value === id) {
        activeServerId.value = servers.value[0]?.server.id ?? null;
      }
    }
  };

  // 设置当前 Server
  const setActiveServer = (id: number | null) => {
    activeServerId.value = id;
  };

  // 更新连接状态
  const setConnectionStatus = (
    id: number,
    status: ConnectionStatus,
    errorMessage?: string
  ) => {
    const serverState = servers.value.find((s) => s.server.id === id);
    if (serverState) {
      serverState.status = status;
      serverState.errorMessage = errorMessage;
    }
  };

  // 获取连接状态
  const getConnectionStatus = (id: number): ConnectionStatus => {
    const serverState = servers.value.find((s) => s.server.id === id);
    return serverState?.status || "disconnected";
  };

  // 复制 Server
  const duplicateServer = async (id: number) => {
    const source = servers.value.find((s) => s.server.id === id);
    if (source) {
      const sourceGroupId = getGroupIdForServer(id);
      const newServer = {
        ...source.server,
        name: `${source.server.name} (副本)`,
        client_id: "", // 清空 Client ID
      };
      // 移除 id 和时间戳
      const { id: _, created_at, updated_at, ...serverData } = newServer;
      await createServer(serverData, sourceGroupId);
    }
  };

  loadSidebarConfig();

  return {
    servers,
    groups,
    activeServerId,
    activeServer,
    loading,
    fetchServers,
    createServer,
    updateServer,
    removeServer,
    setActiveServer,
    setConnectionStatus,
    getConnectionStatus,
    duplicateServer,
    createGroup,
    renameGroup,
    deleteGroup,
    assignServerToGroup,
    getGroupIdForServer,
    toggleGroupCollapsed,
    isGroupCollapsed,
  };
});

// 导出类型
export type { ConnectionStatus };
