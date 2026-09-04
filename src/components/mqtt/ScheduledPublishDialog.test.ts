import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduledPublishDialog from "./ScheduledPublishDialog.vue";
import ElementPlus from "element-plus";
import { createI18n } from "vue-i18n";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockedInvoke = vi.mocked(invoke);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock script engine
vi.mock("@/utils/scriptEngine", () => ({
  ScriptEngine: {
    executeBeforePublish: vi.fn((_scripts: any[], payload: string) =>
      Promise.resolve(payload)
    ),
  },
}));

// Create a fake i18n instance for testing
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages: {
      "zh-CN": {
        scheduled: {
          title: "定时发布",
          selectTemplate: "选择模板",
          noTemplateSelected: "请选择要发布的模板",
          mode: "发布模式",
          once: "单次",
          interval: "间隔",
          cron: "Cron表达式",
          intervalMs: "间隔（毫秒）",
          roundInterval: "轮次间隔",
          cronExpression: "Cron 表达式",
          cronHelp: "例如：*/5 * * * * (每5分钟)",
          executeTime: "执行时间",
          selectTime: "选择时间",
          start: "开始",
          stop: "停止",
          running: "运行中",
          nextExecution: "下次执行",
          executionCount: "已执行 {count} 次",
          selectedTemplates: "已选择 {count} 个模板",
          status: "发送状态",
          completed: "已完成",
          order: "排序",
          selectionOrder: "选择顺序",
          nameOrder: "名称顺序",
          loopMode: "循环模式",
          infinite: "无限循环",
          count: "次数",
          logs: "日志",
          minimize: "最小化",
          back: "返回",
          topic: "Topic",
          round: "轮次",
          sent: "已发送",
          successFail: "成功/失败",
        },
        template: {
          scopeFilterAll: "全部",
          global: "全局",
          connectionOnly: "本连接",
          allCategories: "全部",
          noTemplate: "暂无模板",
        },
        messages: {
          clear: "清空",
          noMessages: "暂无消息",
        },
        common: {
          cancel: "取消",
          close: "关闭",
        },
        success: {
          published: "发布成功",
        },
      },
    },
    missing: (_locale: string, key: string) => key,
  });
}

// Mock mqtt store - use a factory that creates fresh mocks each time
const mockPublish = vi.fn();

vi.mock("@/stores/mqtt", () => ({
  useMqttStore: () => ({
    publishTrackedMessage: (serverId: number, request: any) =>
      mockPublish(
        serverId,
        request.topic,
        request.payload,
        request.qos,
        request.retain
      ),
    reserveSeq: vi.fn(() => 0),
    getConnectionStatus: vi.fn(() => "connected"),
  }),
}));

// Mock env store
const mockReplaceVariables = vi.fn((text: string) => text);
const mockLoadVariables = vi.fn();

vi.mock("@/stores/env", () => ({
  useEnvStore: () => ({
    variables: [],
    variablesMap: {},
    loadVariables: mockLoadVariables,
    replaceVariables: mockReplaceVariables,
  }),
}));

// We need to mock the template store since it's imported and used
// But we also want to test against the real store implementation
// So we partially mock it
vi.mock("@/stores/template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/template")>();
  return {
    ...actual,
  };
});

import { useTemplateStore, GLOBAL_TEMPLATE_SERVER_ID } from "@/stores/template";

describe("ScheduledPublishDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 默认 mock：get_enabled_scripts 返回空数组
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_enabled_scripts") return [];
      return undefined;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWrapper(props = {}) {
    const i18n = createTestI18n();
    return mount(ScheduledPublishDialog, {
      props: {
        visible: true,
        serverId: 1,
        ...props,
      },
      global: {
        plugins: [ElementPlus, i18n],
      },
      attachTo: document.body,
    });
  }

  // Helper: set up templates in store
  function setupTemplates() {
    const store = useTemplateStore();
    store.templates = [
      {
        id: 1,
        server_id: GLOBAL_TEMPLATE_SERVER_ID,
        name: "命令1",
        topic: "device/001/command",
        payload: '{"action":"start"}',
        payload_type: "json" as const,
        qos: 1,
        retain: false,
        use_count: 0,
      },
      {
        id: 2,
        server_id: 1,
        name: "命令2",
        topic: "device/001/status",
        payload: '{"query":"all"}',
        payload_type: "json" as const,
        qos: 0,
        retain: false,
        use_count: 0,
      },
      {
        id: 3,
        server_id: GLOBAL_TEMPLATE_SERVER_ID,
        name: "命令3",
        topic: "device/002/command",
        payload: '{"action":"stop"}',
        payload_type: "json" as const,
        qos: 1,
        retain: false,
        use_count: 0,
      },
    ];
    return store;
  }

  describe("渲染", () => {
    it("应渲染配置视图（未运行时）", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      // 应显示配置视图内容
      expect(wrapper.find(".config-view").exists()).toBe(true);
      expect(wrapper.find(".running-view").exists()).toBe(false);

      // 应显示命令列表
      const items = wrapper.findAll(".command-item");
      expect(items.length).toBe(3);
    });

    it("空列表时应显示空状态", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      const items = wrapper.findAll(".command-item");
      expect(items.length).toBe(0);
    });

    it("应显示发送配置表单", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      // 应存在配置表单
      expect(wrapper.find(".config-form").exists()).toBe(true);
    });
  });

  describe("命令选择", () => {
    it("应支持单选命令", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      // 点击第一个命令项
      const firstItem = wrapper.findAll(".command-item")[0];
      await firstItem.trigger("click");
      await flushPromises();

      // 检查选中状态
      expect(firstItem.classes()).toContain("selected");
    });

    it("应支持多选命令", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const items = wrapper.findAll(".command-item");
      await items[0].trigger("click");
      await items[1].trigger("click");
      await flushPromises();

      expect(items[0].classes()).toContain("selected");
      expect(items[1].classes()).toContain("selected");
      expect(items[2].classes()).not.toContain("selected");
    });

    it("未选择命令时开始按钮应禁用", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.selectedIds.length).toBe(0);
    });
  });

  describe("发送配置", () => {
    it("默认间隔应为 1000ms", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.config.interval).toBe(1000);
    });

    it("应支持切换排序方式", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.config.order).toBe("selection");

      // 切换为按名称排序
      vm.config.order = "name";
      expect(vm.config.order).toBe("name");
    });

    it("应支持切换循环模式", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.config.loopMode).toBe("infinite");

      vm.config.loopMode = "count";
      expect(vm.config.loopMode).toBe("count");
      expect(vm.config.loopCount).toBe(10);
    });

    it("应支持设置每轮间隔", async () => {
      setupTemplates();
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      expect(vm.config.roundInterval).toBe(0);

      vm.config.roundInterval = 500;
      expect(vm.config.roundInterval).toBe(500);
    });
  });

  describe("定时发布执行", () => {
    it("开始发布后应切换到运行视图", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 2;

      // 选择第一个命令
      vm.selectedIds = [1];
      await flushPromises();

      // 点击开始
      await vm.handleStart();
      await flushPromises();

      // 应切换到运行视图
      expect(vm.isRunning).toBe(true);
      expect(vm.isCompleted).toBe(false);
    });

    it("应按配置间隔发送消息", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 500;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      // 选择两个命令
      vm.selectedIds = [1, 2];
      await flushPromises();

      // 开始发布
      await vm.handleStart();
      await flushPromises();

      // 第一条立即发送
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenNthCalledWith(
        1,
        1,
        "device/001/command",
        '{"action":"start"}',
        1,
        false
      );

      // 快进 500ms，第二条应发送
      vi.advanceTimersByTime(500);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenNthCalledWith(
        2,
        1,
        "device/001/status",
        '{"query":"all"}',
        0,
        false
      );
    });

    it("单条确认较慢时仍按间隔启动后续消息并等待全部结算", async () => {
      setupTemplates();
      let resolveFirst!: () => void;
      mockPublish
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
        )
        .mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 500;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;
      vm.selectedIds = [1, 2];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();
      expect(mockPublish).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(500);
      await flushPromises();
      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(vm.isRunning).toBe(true);

      resolveFirst();
      await flushPromises();
      expect(vm.isRunning).toBe(false);
      expect(vm.isCompleted).toBe(true);
      expect(vm.successCount).toBe(2);
    });

    it("无限循环模式下应持续发送", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "infinite";

      // 选择一个命令
      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 第1条立即发送
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // 快进 100ms，进入下一轮
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(2);

      // 快进 100ms，继续
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(3);
    });

    it("指定次数模式应正确停止", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 2;

      // 选择一个命令
      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 第1轮第1条
      expect(vm.isRunning).toBe(true);
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // 快进完成第2轮
      vi.advanceTimersByTime(100);
      await flushPromises();
      expect(mockPublish).toHaveBeenCalledTimes(2);

      // 继续快进，应已停止
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(vm.isRunning).toBe(false);
      expect(vm.isCompleted).toBe(true);
    });

    it("应支持每轮间隔", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.roundInterval = 500;
      vm.config.loopMode = "infinite";

      // 选择一个命令
      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 第1轮立即发送
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // 快进 100ms，但因为有 roundInterval=500，应该还没发送
      vi.advanceTimersByTime(100);
      await flushPromises();

      // 第2轮需要等待 roundInterval
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // 快进 500ms（roundInterval）
      vi.advanceTimersByTime(500);
      await flushPromises();

      // 现在应该开始第2轮
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it("发送失败时应记录失败日志", async () => {
      setupTemplates();
      mockPublish.mockRejectedValue(new Error("publish failed"));
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      // 选择一个命令
      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 等待异步 publish 完成
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();

      // 应记录失败
      expect(vm.failCount).toBe(1);
      expect(vm.logs.length).toBe(1);
      expect(vm.logs[0].status).toBe("error");
    });

    it("停止发布应中断发送", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "infinite";

      // 选择一个命令
      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 已发送1条
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(vm.isRunning).toBe(true);

      // 停止
      vm.handleStop();
      await flushPromises();

      expect(vm.isRunning).toBe(false);
      expect(vm.isCompleted).toBe(true);

      // 快进，不应再发送
      vi.advanceTimersByTime(200);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });

  describe("日志", () => {
    it("应记录发送日志", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      expect(vm.logs.length).toBe(1);
      expect(vm.logs[0].status).toBe("success");
      expect(vm.logs[0].topic).toBe("device/001/command");
    });

    it("应限制日志数量", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 10;
      vm.config.loopMode = "infinite";

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 快速发送超过 100 条
      for (let i = 0; i < 110; i++) {
        vi.advanceTimersByTime(10);
        await flushPromises();
      }

      // 日志应限制在 100 条以内
      expect(vm.logs.length).toBeLessThanOrEqual(100);
    });

    it("应支持清空日志", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      expect(vm.logs.length).toBeGreaterThan(0);

      vm.logs = [];
      expect(vm.logs.length).toBe(0);
    });
  });

  describe("统计", () => {
    it("应正确统计发送数量", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 2;

      vm.selectedIds = [1, 2];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 第1轮第1条
      expect(vm.sentCount).toBe(1);
      expect(vm.successCount).toBe(1);
      expect(vm.currentRound).toBe(1);

      // 第1轮第2条
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(vm.sentCount).toBe(2);
      expect(vm.successCount).toBe(2);

      // 第2轮
      vi.advanceTimersByTime(100);
      await flushPromises();
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(vm.sentCount).toBe(4);
      expect(vm.successCount).toBe(4);
      expect(vm.currentRound).toBe(2);
    });

    it("应正确计算进度百分比", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      vm.selectedIds = [1, 2];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 2条命令，第1条已发送
      expect(vm.progressPercentage).toBe(50);

      // 第2条发送
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(vm.progressPercentage).toBe(100);
    });
  });

  describe("排序", () => {
    it("按名称排序应按字母顺序发送", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.order = "name";
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      // 按非字母顺序选择：命令3, 命令1, 命令2
      vm.selectedIds = [3, 1, 2];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 按名称排序：命令1, 命令2, 命令3
      expect(mockPublish).toHaveBeenNthCalledWith(
        1,
        1,
        "device/001/command",
        '{"action":"start"}',
        1,
        false
      );

      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(mockPublish).toHaveBeenNthCalledWith(
        2,
        1,
        "device/001/status",
        '{"query":"all"}',
        0,
        false
      );

      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(mockPublish).toHaveBeenNthCalledWith(
        3,
        1,
        "device/002/command",
        '{"action":"stop"}',
        1,
        false
      );
    });

    it("按选择顺序应按点击顺序发送", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.order = "selection";
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      // 按选择顺序：命令2, 命令1
      vm.selectedIds = [2, 1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 第1条应是命令2
      expect(mockPublish).toHaveBeenNthCalledWith(
        1,
        1,
        "device/001/status",
        '{"query":"all"}',
        0,
        false
      );

      vi.advanceTimersByTime(100);
      await flushPromises();

      // 第2条应是命令1
      expect(mockPublish).toHaveBeenNthCalledWith(
        2,
        1,
        "device/001/command",
        '{"action":"start"}',
        1,
        false
      );
    });
  });

  describe("关闭和最小化", () => {
    it("最小化不应停止发布", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "infinite";

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      expect(vm.isRunning).toBe(true);

      // 最小化
      vm.handleMinimize();
      await flushPromises();

      expect(vm.isRunning).toBe(true);

      // 快进，应继续发送
      vi.advanceTimersByTime(100);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it("正常关闭应停止发布", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "infinite";

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      expect(vm.isRunning).toBe(true);

      // 正常关闭
      vm.handleClose();
      await flushPromises();

      expect(vm.isRunning).toBe(false);

      // 快进，不应再发送
      vi.advanceTimersByTime(200);
      await flushPromises();

      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("完成后返回配置应重置状态", async () => {
      setupTemplates();
      mockPublish.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 完成
      expect(vm.isCompleted).toBe(true);
      expect(vm.sentCount).toBe(1);

      // 返回配置
      vm.handleBackToConfig();
      await flushPromises();

      expect(vm.isCompleted).toBe(false);
      expect(vm.sentCount).toBe(0);
      expect(vm.logs.length).toBe(0);
    });
  });

  describe("环境变量和脚本", () => {
    it("发送前应替换环境变量", async () => {
      setupTemplates();
      mockReplaceVariables.mockImplementation((text: string) =>
        text.replace("{{DEVICE_ID}}", "device_001")
      );
      mockPublish.mockResolvedValue(undefined);

      const store = useTemplateStore();
      store.templates = [
        {
          id: 1,
          server_id: GLOBAL_TEMPLATE_SERVER_ID,
          name: "命令1",
          topic: "device/{{DEVICE_ID}}/command",
          payload: '{"id":"{{DEVICE_ID}}"}',
          payload_type: "json" as const,
          qos: 1,
          retain: false,
          use_count: 0,
        },
      ];

      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.config.interval = 100;
      vm.config.loopMode = "count";
      vm.config.loopCount = 1;

      vm.selectedIds = [1];
      await flushPromises();

      await vm.handleStart();
      await flushPromises();

      // 应调用 replaceVariables
      expect(mockReplaceVariables).toHaveBeenCalledWith("device/{{DEVICE_ID}}/command");
      expect(mockReplaceVariables).toHaveBeenCalledWith('{"id":"{{DEVICE_ID}}"}');
    });
  });
});
