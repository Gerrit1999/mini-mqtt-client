import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import MessageList from "./MessageList.vue";
import ElementPlus from "element-plus";
import { createI18n } from "vue-i18n";
import type { MessageHistory, MqttMessage } from "@/types/mqtt";

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const fileMocks = vi.hoisted(() => ({
  save: vi.fn(),
  writeTextFile: vi.fn(),
}));
const mockSave = fileMocks.save;
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: fileMocks.save,
}));

const mockWriteTextFile = fileMocks.writeTextFile;
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: fileMocks.writeTextFile,
}));

// Mock stores
const mockMessages = vi.fn(() => [] as MqttMessage[]);
const mockHistoryMessages = vi.fn<() => MessageHistory[]>(() => []);
const mockFetchMessageHistory = vi.fn(() => Promise.resolve());
const mockFetchAllMessageHistory = vi.fn(() => Promise.resolve([] as MessageHistory[]));
const mockLoadMoreMessageHistory = vi.fn(() => Promise.resolve());
const mockClearHistory = vi.fn(() => Promise.resolve());
const mockGetHasMoreHistory = vi.fn(() => false);

vi.mock("@/stores/server", () => ({
  useServerStore: () => ({
    activeServerId: 1,
  }),
}));

vi.mock("@/stores/mqtt", () => ({
  useMqttStore: () => ({
    getServerMessages: mockMessages,
    getReceivedCount: vi.fn(() => 0),
    clearMessages: vi.fn(),
  }),
}));

vi.mock("@/stores/message", () => ({
  useMessageStore: () => ({
    loading: false,
    loadingMore: false,
    fetchMessageHistory: mockFetchMessageHistory,
    fetchAllMessageHistory: mockFetchAllMessageHistory,
    loadMoreMessageHistory: mockLoadMoreMessageHistory,
    clearHistory: mockClearHistory,
    getMessages: mockHistoryMessages,
    getHasMoreHistory: mockGetHasMoreHistory,
  }),
}));

vi.mock("@/stores/app", () => ({
  useAppStore: () => ({
    autoScroll: true,
    messageLimit: 1000,
    setAutoScroll: vi.fn(),
    setCopyToPublish: vi.fn(),
    getDateLocale: () => "zh-CN",
  }),
}));

vi.mock("@/stores/subscription", () => ({
  useSubscriptionStore: () => ({
    getSubscriptionByTopic: vi.fn(() => undefined),
  }),
}));

// Create test i18n
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages: {
      "zh-CN": {
        messages: {
          title: "消息列表",
          noMessages: "暂无消息",
          clear: "清空",
          export: "导出",
          exportEmpty: "没有可导出的消息",
          exportSuccess: "已导出 {count} 条消息到 {path}",
          copyPayload: "复制",
          copyToPublish: "复制到发布",
          copied: "消息已复制",
          viewPayload: "查看消息内容",
          formatJson: "JSON格式化",
          autoScroll: "自动滚动到底部",
          countSummary: "当前保留数 / 累计接收数",
          clearConfirm: "确定要清空所有消息吗？",
          clearTitle: "清空消息",
          search: {
            matchCase: "区分大小写",
            wholeWord: "全词匹配",
            useRegex: "使用正则表达式",
            invalidRegex: "正则表达式无效",
          },
          loadMore: "加载更早消息",
          loadingHistory: "正在加载历史消息",
          direction: {
            received: "接收",
            sent: "发送",
          },
          publishStatus: {
            label: "发布状态",
            pending: "等待发送",
            sent: "已发送",
            confirmed: "已确认",
            failed: "失败",
            untracked: "未跟踪",
          },
        },
        template: {
          allCategories: "全部",
          searchPlaceholder: "搜索模板...",
        },
        publish: {
          topic: "Topic",
          qos: "QoS",
          retain: "Retain",
          payload: "Payload",
          payloadType: "格式",
          send: "发送",
        },
        common: {
          confirm: "确定",
          cancel: "取消",
          edit: "编辑",
          delete: "删除",
          close: "关闭",
        },
        success: {
          deleted: "已删除",
          copied: "已复制",
        },
        script: {
          testError: "测试失败",
        },
        errors: {
          saveFailed: "保存失败",
        },
      },
    },
    missing: (_locale: string, key: string) => key,
  });
}

function createTestMessages(): MqttMessage[] {
  return [
    {
      id: 1,
      server_id: 1,
      direction: "receive",
      topic: "device/002/status",
      payload: new TextEncoder().encode('{"temp":25}'),
      qos: 0,
      retain: false,
      timestamp: "2024-01-01T00:00:00Z",
      payload_type: "json",
    },
    {
      id: 2,
      server_id: 1,
      direction: "receive",
      topic: "device/001/command",
      payload: new TextEncoder().encode('{"action":"on"}'),
      qos: 1,
      retain: false,
      timestamp: "2024-01-01T00:00:01Z",
      payload_type: "json",
    },
    {
      id: 3,
      server_id: 1,
      direction: "publish",
      topic: "device/001/command",
      payload: new TextEncoder().encode('{"action":"on"}'),
      qos: 1,
      retain: false,
      timestamp: "2024-01-01T00:00:02Z",
      payload_type: "json",
    },
    {
      id: 4,
      server_id: 1,
      direction: "receive",
      topic: "device/002/status",
      payload: new TextEncoder().encode('{"temp":26}'),
      qos: 0,
      retain: false,
      timestamp: "2024-01-01T00:00:03Z",
      payload_type: "json",
    },
    {
      id: 5,
      server_id: 1,
      direction: "receive",
      topic: "sensor/temp",
      payload: new TextEncoder().encode("28.5"),
      qos: 0,
      retain: false,
      timestamp: "2024-01-01T00:00:04Z",
      payload_type: "text",
    },
  ];
}

describe("MessageList Topic 筛选", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockMessages.mockReturnValue([]);
    mockHistoryMessages.mockReturnValue([]);
    mockFetchAllMessageHistory.mockResolvedValue([]);
    mockSave.mockResolvedValue(null);
    mockWriteTextFile.mockResolvedValue(undefined);
  });

  function createWrapper() {
    const i18n = createTestI18n();
    return mount(MessageList, {
      global: {
        plugins: [ElementPlus, i18n],
      },
      attachTo: document.body,
    });
  }

  describe("topics computed", () => {
    it("挂载时应加载第一页历史消息", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      expect(mockFetchMessageHistory).toHaveBeenCalledWith(1, 200);
      wrapper.unmount();
    });

    it("应从消息中提取唯一 Topic 并排序", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.topics).toEqual([
        "device/001/command",
        "device/002/status",
        "sensor/temp",
      ]);
    });

    it("应合并历史消息与实时消息", async () => {
      mockHistoryMessages.mockReturnValue([
        {
          id: 11,
          server_id: 1,
          direction: "publish",
          topic: "history/topic",
          payload: "legacy",
          payload_format: "text",
          qos: 0,
          retain: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ]);
      mockMessages.mockReturnValue(createTestMessages());

      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.topics).toEqual([
        "device/001/command",
        "device/002/status",
        "history/topic",
        "sensor/temp",
      ]);
    });

    it("应按 operation ID 合并历史与实时发布状态", async () => {
      mockHistoryMessages.mockReturnValue([
        {
          id: 11,
          server_id: 1,
          direction: "publish",
          topic: "tracked/topic",
          payload: "value",
          payload_format: "text",
          qos: 1,
          retain: false,
          created_at: "2026-09-04T00:00:00Z",
          operation_id: "op-1",
          publish_status: "confirmed",
          packet_id: 41,
        },
      ]);
      mockMessages.mockReturnValue([
        {
          server_id: 1,
          direction: "publish",
          topic: "tracked/topic",
          payload: new TextEncoder().encode("value"),
          qos: 1,
          retain: false,
          timestamp: "2026-09-04T00:00:00Z",
          operation_id: "op-1",
          publish_status: "sent",
          packet_id: 41,
          seq: 1,
        },
      ]);

      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.messages).toHaveLength(1);
      expect(vm.messages[0]).toMatchObject({
        id: 11,
        operation_id: "op-1",
        publish_status: "confirmed",
      });
    });

    it("应渲染失败状态和 Broker 错误原因", async () => {
      mockMessages.mockReturnValue([
        {
          server_id: 1,
          direction: "publish",
          topic: "tracked/topic",
          payload: new TextEncoder().encode("value"),
          qos: 1,
          retain: false,
          timestamp: "2026-09-04T00:00:00Z",
          operation_id: "op-failed",
          publish_status: "failed",
          publish_error: "Broker rejected publish: NotAuthorized",
        },
      ]);

      const wrapper = createWrapper();
      await flushPromises();

      expect(wrapper.text()).toContain("失败");
      expect(wrapper.text()).toContain("Broker rejected publish: NotAuthorized");
    });

    it("空消息时应返回空数组", async () => {
      mockMessages.mockReturnValue([]);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.topics).toEqual([]);
    });

    it("应过滤掉空 topic 的消息", async () => {
      mockMessages.mockReturnValue([
        {
          id: 1,
          server_id: 1,
          direction: "receive",
          topic: "",
          payload: new Uint8Array(),
          qos: 0,
          retain: false,
        },
        {
          id: 2,
          server_id: 1,
          direction: "receive",
          topic: "valid/topic",
          payload: new Uint8Array(),
          qos: 0,
          retain: false,
        },
      ]);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.topics).toEqual(["valid/topic"]);
    });
  });

  describe("filteredMessages with topic filter", () => {
    it("单选 Topic 时应只显示该 Topic 的消息", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.selectedTopics = ["sensor/temp"];
      await flushPromises();

      expect(vm.filteredMessages).toHaveLength(1);
      expect(vm.filteredMessages[0].topic).toBe("sensor/temp");
    });

    it("多选 Topic 时应显示匹配任一 Topic 的消息（OR 逻辑）", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.selectedTopics = ["device/001/command", "sensor/temp"];
      await flushPromises();

      expect(vm.filteredMessages).toHaveLength(3);
      expect(vm.filteredMessages.map((m: MqttMessage) => m.id)).toEqual([2, 3, 5]);
    });

    it("未选择 Topic 时不应过滤", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.selectedTopics = [];
      await flushPromises();

      expect(vm.filteredMessages).toHaveLength(5);
    });

    it("Topic 筛选应与方向筛选组合生效", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.selectedTopics = ["device/001/command"];
      vm.directionFilter = "receive";
      await flushPromises();

      expect(vm.filteredMessages).toHaveLength(1);
      expect(vm.filteredMessages[0].id).toBe(2);
      expect(vm.filteredMessages[0].direction).toBe("receive");
    });

    it("Topic 筛选应与关键词搜索组合生效", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.selectedTopics = ["device/001/command"];
      vm.searchKeyword = "device";
      await flushPromises();

      // device/001/command 有 2 条消息，关键词 "device" 匹配 topic
      expect(vm.filteredMessages).toHaveLength(2);
    });

    it("方向 + Topic 双重筛选", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.directionFilter = "publish";
      vm.selectedTopics = ["device/001/command"];
      await flushPromises();

      expect(vm.filteredMessages).toHaveLength(1);
      expect(vm.filteredMessages[0].id).toBe(3);
      expect(vm.filteredMessages[0].direction).toBe("publish");
    });
  });

  describe("Topic select 交互", () => {
    it("应渲染 Topic 筛选下拉框", async () => {
      mockMessages.mockReturnValue(createTestMessages());
      const wrapper = createWrapper();
      await flushPromises();

      const select = wrapper.find(".header-actions .el-select");
      expect(select.exists()).toBe(true);
    });

    it("Topic 筛选下拉框应正确渲染选项", async () => {
      mockMessages.mockReturnValue([
        { id: 1, server_id: 1, direction: "receive", topic: "topic/A", payload: new Uint8Array(), qos: 0, retain: false },
        { id: 2, server_id: 1, direction: "receive", topic: "topic/B", payload: new Uint8Array(), qos: 0, retain: false },
      ]);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.topics).toEqual(["topic/A", "topic/B"]);
    });
  });

  describe("导出", () => {
    it("应导出完整本地历史，而不是当前保留窗口", async () => {
      mockHistoryMessages.mockReturnValue([]);
      mockFetchAllMessageHistory.mockResolvedValue([
        {
          id: 101,
          server_id: 1,
          direction: "receive",
          topic: "history/topic",
          payload: "from-history",
          payload_format: "text",
          qos: 0,
          retain: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ]);
      mockSave.mockResolvedValue("/tmp/messages.json");

      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      await vm.handleExportCommand("json");

      expect(mockFetchAllMessageHistory).toHaveBeenCalledWith(1);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);

      const [savedPath, content] = mockWriteTextFile.mock.calls[0];
      expect(savedPath).toBe("/tmp/messages.json");
      expect(content).toContain('"topic": "history/topic"');
    });
  });
});
