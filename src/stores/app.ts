import { defineStore } from "pinia";
import { ref } from "vue";
import { getCurrentWindow, type Theme as TauriTheme } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import i18n, { getActualLocale, type Locale, type ActualLocale } from "@/i18n";

export type Theme = "light" | "dark" | "auto";
export type ViewType = "messages" | "templates";
export type { Locale, ActualLocale };

export const GITHUB_REPO = 'Gerrit1999/mini-mqtt-client';

// 版本更新信息
export interface UpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
}

export interface AppSettings {
  message_limit: number;
  mqtt_packet_size_limit_kb: number;
  message_retention_days: number;
  message_retention_count: number;
}

// 复制到发布面板的消息数据
export interface CopyToPublishData {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  payloadType?: string; // "json" | "hex" | "text"
}

export const useAppStore = defineStore("app", () => {
  // 主题
  const theme = ref<Theme>("light");
  
  // 语言
  const locale = ref<Locale>("auto");
  const actualLocale = ref<ActualLocale>("zh-CN");
  
  // 主题监听取消函数
  let unlistenTheme: (() => void) | null = null;

  // 侧边栏折叠状态
  const sidebarCollapsed = ref(false);

  // 当前视图
  const currentView = ref<ViewType>("messages");

  // 复制到发布面板的消息
  const copyToPublishData = ref<CopyToPublishData | null>(null);

  // 消息列表自动滚动到底部
  const autoScroll = ref(true);

  // 每个 server 保留的消息上限
  const messageLimit = ref(1000);

  // MQTT 收发包大小上限（KB）
  const mqttPacketSizeLimitKb = ref(1024);

  // SQLite 消息历史保留策略
  const messageRetentionDays = ref(30);
  const messageRetentionCount = ref(100000);

  // 版本更新信息
  const updateInfo = ref<UpdateInfo | null>(null);
  const checkingUpdate = ref(false);

  // 获取系统主题（使用 Tauri API）
  const getSystemTheme = async (): Promise<"light" | "dark"> => {
    try {
      const appWindow = getCurrentWindow();
      const tauriTheme = await appWindow.theme();
      return tauriTheme === "dark" ? "dark" : "light";
    } catch {
      // 降级使用 CSS 媒体查询
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  };

  // 系统主题变化处理
  const handleSystemThemeChange = (tauriTheme: TauriTheme | null) => {
    if (theme.value === "auto" && tauriTheme) {
      applyThemeToDOM(tauriTheme === "dark" ? "dark" : "light");
    }
  };

  // 切换主题
  const toggleTheme = () => {
    const themes: Theme[] = ["light", "dark", "auto"];
    const currentIndex = themes.indexOf(theme.value);
    theme.value = themes[(currentIndex + 1) % themes.length];
    applyTheme();
    saveTheme();
  };

  // 设置主题
  const setTheme = (newTheme: Theme) => {
    theme.value = newTheme;
    applyTheme();
    saveTheme();
  };

  // 应用主题到 DOM（内部方法）
  const applyThemeToDOM = (actualTheme: "light" | "dark") => {
    if (actualTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  // 应用主题到 DOM
  const applyTheme = async () => {
    // 移除旧的监听器
    if (unlistenTheme) {
      unlistenTheme();
      unlistenTheme = null;
    }

    if (theme.value === "auto") {
      // 自动模式：根据系统主题设置，并监听变化
      const systemTheme = await getSystemTheme();
      applyThemeToDOM(systemTheme);
      
      // 监听系统主题变化
      try {
        const appWindow = getCurrentWindow();
        unlistenTheme = await appWindow.onThemeChanged(({ payload }) => {
          handleSystemThemeChange(payload);
        });
      } catch (e) {
        console.warn("无法监听系统主题变化:", e);
      }
    } else {
      // 手动模式：直接应用
      applyThemeToDOM(theme.value);
    }
  };

  // 保存主题到本地存储
  const saveTheme = () => {
    localStorage.setItem("mqtt-client-theme", theme.value);
  };

  // 初始化主题
  const initTheme = async () => {
    const stored = localStorage.getItem("mqtt-client-theme");
    if (stored === "light" || stored === "dark" || stored === "auto") {
      theme.value = stored;
    } else {
      // 默认使用自动模式
      theme.value = "auto";
    }
    await applyTheme();
  };

  // 清理监听器
  const cleanup = () => {
    if (unlistenTheme) {
      unlistenTheme();
      unlistenTheme = null;
    }
  };

  // ===== 语言相关 =====

  // 应用语言设置
  const applyLocale = () => {
    const newActualLocale = getActualLocale(locale.value);
    actualLocale.value = newActualLocale;
    i18n.global.locale.value = newActualLocale;
  };

  // 设置语言
  const setLocale = (newLocale: Locale) => {
    locale.value = newLocale;
    applyLocale();
    saveLocale();
  };

  // 保存语言到本地存储
  const saveLocale = () => {
    localStorage.setItem("mqtt-client-locale", locale.value);
  };

  // 初始化语言
  const initLocale = () => {
    const stored = localStorage.getItem("mqtt-client-locale");
    if (stored === "auto" || stored === "zh-CN" || stored === "en-US") {
      locale.value = stored;
    } else {
      // 默认跟随系统
      locale.value = "auto";
    }
    applyLocale();
  };

  // 获取用于时间格式化的 locale
  const getDateLocale = (): string => {
    return actualLocale.value === "zh-CN" ? "zh-CN" : "en-US";
  };

  // 切换侧边栏
  const toggleSidebar = () => {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  };

  // 保存自动滚动设置到本地存储
  const saveAutoScroll = () => {
    localStorage.setItem("mqtt-client-auto-scroll", autoScroll.value ? "true" : "false");
  };

  // 初始化自动滚动设置
  const initAutoScroll = () => {
    const stored = localStorage.getItem("mqtt-client-auto-scroll");
    if (stored === "false") {
      autoScroll.value = false;
    } else {
      // 默认开启
      autoScroll.value = true;
    }
  };

  // 设置自动滚动
  const setAutoScroll = (value: boolean) => {
    autoScroll.value = value;
    saveAutoScroll();
  };

  const initAppSettings = async () => {
    try {
      const settings = await invoke<AppSettings>("get_app_settings");
      messageLimit.value = settings.message_limit;
      mqttPacketSizeLimitKb.value = settings.mqtt_packet_size_limit_kb;
      messageRetentionDays.value = settings.message_retention_days;
      messageRetentionCount.value = settings.message_retention_count;
    } catch (error) {
      console.warn("Failed to load app settings:", error);
      messageLimit.value = 1000;
      mqttPacketSizeLimitKb.value = 1024;
      messageRetentionDays.value = 30;
      messageRetentionCount.value = 100000;
    }
  };

  const setMessageLimit = (value: number) => {
    messageLimit.value = value;
  };

  const setMqttPacketSizeLimitKb = (value: number) => {
    mqttPacketSizeLimitKb.value = value;
  };

  const setMessageCleanupPolicy = (days: number, count: number) => {
    messageRetentionDays.value = days;
    messageRetentionCount.value = count;
  };

  // 设置当前视图
  const setCurrentView = (view: ViewType) => {
    currentView.value = view;
  };

  // 设置复制到发布面板的消息
  const setCopyToPublish = (data: CopyToPublishData) => {
    copyToPublishData.value = data;
  };

  // 清除复制到发布面板的消息
  const clearCopyToPublish = () => {
    copyToPublishData.value = null;
  };

  // 比较版本号
  const compareVersions = (v1: string, v2: string): number => {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  };

  // 检查更新
  const checkUpdate = async (): Promise<UpdateInfo | null> => {
    if (checkingUpdate.value) return null;
    
    checkingUpdate.value = true;
    try {
      const currentVersion = await getVersion();
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      
      if (!response.ok) {
        throw new Error('获取版本信息失败');
      }
      
      const data = await response.json();
      const latestVersion = data.tag_name?.replace(/^v/, '') || '';
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
      
      updateInfo.value = { 
        hasUpdate, 
        latestVersion: `v${latestVersion}`,
        currentVersion 
      };
      
      return updateInfo.value;
    } catch (e) {
      console.error('检查更新失败:', e);
      return null;
    } finally {
      checkingUpdate.value = false;
    }
  };

  // 清除更新信息
  const clearUpdateInfo = () => {
    updateInfo.value = null;
  };

  return {
    theme,
    locale,
    actualLocale,
    sidebarCollapsed,
    currentView,
    copyToPublishData,
    autoScroll,
    messageLimit,
    mqttPacketSizeLimitKb,
    messageRetentionDays,
    messageRetentionCount,
    updateInfo,
    checkingUpdate,
    toggleTheme,
    setTheme,
    initTheme,
    setLocale,
    initLocale,
    getDateLocale,
    toggleSidebar,
    setCurrentView,
    setCopyToPublish,
    clearCopyToPublish,
    setAutoScroll,
    initAutoScroll,
    initAppSettings,
    setMessageLimit,
    setMqttPacketSizeLimitKb,
    setMessageCleanupPolicy,
    checkUpdate,
    clearUpdateInfo,
    cleanup,
  };
});
