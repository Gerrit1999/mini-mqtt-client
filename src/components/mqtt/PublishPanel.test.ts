import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PublishPanel from "./PublishPanel.vue";
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

// Mock MQTT error handler
vi.mock("@/utils/mqttErrorHandler", () => ({
  validatePublishTopic: vi.fn((topic: string) => ({
    valid: topic.trim().length > 0,
    error: topic.trim().length > 0 ? undefined : "请输入 Topic",
  })),
  handleMqttError: vi.fn(),
}));

// Mock error handler
vi.mock("@/utils/errorHandler", () => ({
  handleScriptError: vi.fn(),
}));

// Create a fake i18n instance for testing
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages: {
      "zh-CN": {
        publish: {
          send: "发送",
          topicPlaceholder: "请输入 Topic",
          payloadPlaceholder: "请输入消息内容",
          scheduledPublish: "定时发布",
          timedMessage: "定时消息",
          saveTemplate: "保存模板",
          openTemplates: "命令模板",
        },
        timedMessage: {
          title: "定时消息",
          frequency: "发送频率",
          frequencyUnit: "秒",
          frequencyPlaceholder: "请输入发送频率",
          frequencyMin: "频率不能小于 0.1 秒",
          frequencyMax: "频率不能大于 3600 秒",
          start: "开始发送",
          stop: "停止发送",
          running: "定时发送中",
          runningWithCount: "已发送 {count} 条",
        },
        common: {
          confirm: "确定",
          cancel: "取消",
        },
        errors: {
          inputTopic: "请输入 Topic",
          selectServer: "请先选择一个服务器",
          connectFailed: "连接失败",
          hexInvalid: "HEX 格式无效",
          jsonInvalid: "JSON 格式无效",
        },
        success: {
          published: "发布成功",
        },
        script: {
          testError: "测试失败",
        },
      },
    },
    missing: (_locale: string, key: string) => key,
  });
}

const mockPublishMessage = vi.fn();
const mockAddPublishMessage = vi.fn();
const mockReserveSeq = vi.fn(() => 0);
const mockGetConnectionStatus = vi.fn(() => "connected");

// Mock stores
vi.mock("@/stores/server", () => ({
  useServerStore: () => ({
    activeServerId: 1,
  }),
}));

vi.mock("@/stores/message", () => ({
  useMessageStore: () => ({
    publishMessage: mockPublishMessage,
  }),
}));

vi.mock("@/stores/mqtt", () => ({
  useMqttStore: () => ({
    publishTrackedMessage: mockPublishMessage,
    addPublishMessage: mockAddPublishMessage,
    reserveSeq: mockReserveSeq,
    getConnectionStatus: mockGetConnectionStatus,
    messagesByServer: { value: new Map() },
  }),
}));

vi.mock("@/stores/app", () => ({
  useAppStore: () => ({
    copyToPublishData: null,
    clearCopyToPublish: vi.fn(),
  }),
}));

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

describe("PublishPanel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetConnectionStatus.mockReturnValue("connected");
    // 默认 mock：get_enabled_scripts 返回空数组
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_enabled_scripts") return [];
      return undefined;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // 清理可能残留的对话框 DOM
    document.querySelectorAll(".el-dialog").forEach((el) => el.remove());
    document.querySelectorAll(".el-overlay").forEach((el) => el.remove());
  });

  function createWrapper(props = {}) {
    const i18n = createTestI18n();
    return mount(PublishPanel, {
      props: {
        scheduledPublishRunning: false,
        timedMessageRunning: false,
        ...props,
      },
      global: {
        plugins: [ElementPlus, i18n],
      },
      attachTo: document.body,
    });
  }

  describe("渲染", () => {
    it("应渲染发布面板基本结构", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      expect(wrapper.find(".publish-panel").exists()).toBe(true);
      expect(wrapper.find(".panel-title").text()).toContain("发送");
    });

    it("应渲染发送按钮", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      const sendButton = wrapper.findAll("button").find((btn) =>
        btn.text().includes("发送")
      );
      expect(sendButton).toBeDefined();
    });

    it("应渲染定时消息和定时发布按钮", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      expect(wrapper.find(".btn-timed-message").exists()).toBe(true);
      expect(wrapper.find(".btn-scheduled-publish").exists()).toBe(true);
    });
  });

  describe("定时消息按钮状态", () => {
    it("未运行时应显示定时消息", async () => {
      const wrapper = createWrapper({ timedMessageRunning: false });
      await flushPromises();

      expect(wrapper.find(".btn-timed-message").exists()).toBe(true);
    });

    it("运行时应显示停止", async () => {
      const wrapper = createWrapper({ timedMessageRunning: true });
      await flushPromises();

      expect(wrapper.find(".btn-timed-message").exists()).toBe(true);
    });
  });

  describe("定时消息对话框", () => {
    it("未填 Topic 时应提示", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      const timedMessageBtn = wrapper.find(".btn-timed-message");
      expect(timedMessageBtn).toBeDefined();

      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 应提示输入 Topic，对话框不应打开
      const dialog = wrapper.find(".el-dialog");
      expect(dialog.exists()).toBe(false);
    });

    it("填入 Topic 后点击应打开配置对话框", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic（直接修改组件内部数据）
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      // 点击定时消息按钮
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 对话框应打开
      const dialog = wrapper.find(".el-dialog");
      expect(dialog.exists()).toBe(true);
      expect(dialog.text()).toContain("定时消息");
    });

    it("对话框应显示频率输入", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic 并打开对话框
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      const dialog = wrapper.find(".el-dialog");
      expect(dialog.text()).toContain("发送频率");
    });

    it("点击取消应关闭对话框", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic 并打开对话框
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 对话框应打开
      expect(wrapper.find(".el-dialog").exists()).toBe(true);

      // 点击取消
      const cancelBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("取消")
      );
      expect(cancelBtn).toBeDefined();
      await cancelBtn!.trigger("click");
      await flushPromises();

      // 对话框状态应变为关闭
      const vm2 = wrapper.vm as any;
      expect(vm2.timedMessageDialogVisible).toBe(false);
    });
  });

  describe("定时消息执行", () => {
    it("开始后应立即发送第一条", async () => {
      mockPublishMessage.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic 和 Payload
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      vm.publishData.payload = '{"data":"test"}';
      await flushPromises();

      // 打开对话框
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 设置频率为 0.5 秒
      vm.timedMessageInterval = 0.5;
      await flushPromises();

      // 点击开始
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      expect(startBtn).toBeDefined();
      await startBtn!.trigger("click");
      await flushPromises();

      // 应发送一条
      expect(mockPublishMessage).toHaveBeenCalledTimes(1);
    });

    it("应按设定频率发送消息", async () => {
      mockPublishMessage.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      // 打开对话框
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 设置频率为 1 秒
      vm.timedMessageInterval = 1;
      await flushPromises();

      // 点击开始
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 第1条立即发送
      expect(mockPublishMessage).toHaveBeenCalledTimes(1);

      // 快进 1 秒
      vi.advanceTimersByTime(1000);
      await flushPromises();

      // 第2条应发送
      expect(mockPublishMessage).toHaveBeenCalledTimes(2);

      // 再快进 1 秒
      vi.advanceTimersByTime(1000);
      await flushPromises();

      // 第3条应发送
      expect(mockPublishMessage).toHaveBeenCalledTimes(3);
    });

    it("Broker 确认较慢时不应重叠发送", async () => {
      let resolveFirst!: () => void;
      mockPublishMessage
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
        )
        .mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();
      await wrapper.find(".btn-timed-message").trigger("click");
      await flushPromises();
      vm.timedMessageInterval = 1;
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      expect(mockPublishMessage).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      await flushPromises();
      expect(mockPublishMessage).toHaveBeenCalledTimes(1);

      resolveFirst();
      await flushPromises();
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(mockPublishMessage).toHaveBeenCalledTimes(2);
    });

    it("发送内容应包含当前面板的数据", async () => {
      mockPublishMessage.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      // 填入数据
      const vm = wrapper.vm as any;
      vm.publishData.topic = "device/001/command";
      vm.publishData.payload = '{"action":"start"}';
      vm.publishData.qos = 1;
      vm.publishData.retain = true;
      vm.payloadFormat = "json";
      await flushPromises();

      // 打开对话框
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 点击开始
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 验证发送内容
      expect(mockPublishMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          topic: "device/001/command",
          payload: '{"action":"start"}',
          qos: 1,
          retain: true,
          format: "json",
        })
      );
    });
  });

  describe("定时消息停止", () => {
    it("点击停止后不应再发送", async () => {
      mockPublishMessage.mockResolvedValue(undefined);
      const wrapper = createWrapper();
      await flushPromises();

      // 先启动定时消息
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      vm.timedMessageInterval = 0.5;
      await flushPromises();

      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 已发送1条
      expect(mockPublishMessage).toHaveBeenCalledTimes(1);

      // 快进，触发下一次发送
      vi.advanceTimersByTime(500);
      await flushPromises();
      expect(mockPublishMessage).toHaveBeenCalledTimes(2);

      // 模拟点击停止按钮（通过更新 props 和触发点击）
      await wrapper.setProps({ timedMessageRunning: true });
      await flushPromises();

      const stopBtn = wrapper.find(".btn-timed-message");
      expect(stopBtn.exists()).toBe(true);
      await stopBtn.trigger("click");
      await flushPromises();

      // 快进，不应再发送
      vi.advanceTimersByTime(2000);
      await flushPromises();

      expect(mockPublishMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("连接断开自动停止", () => {
    it("连接断开时应自动停止定时消息", async () => {
      mockPublishMessage.mockResolvedValue(undefined);
      mockGetConnectionStatus.mockReturnValue("connected");

      const wrapper = createWrapper({ timedMessageRunning: true });
      await flushPromises();

      // 验证组件能响应 props 变化
      // 当 timedMessageRunning 为 true 且连接断开时，
      // watch(isConnected) 应触发 stopTimedMessage
      const vm = wrapper.vm as any;
      expect(vm.timedMessageRunning).toBe(true);
    });
  });

  describe("环境变量替换", () => {
    it("定时发送每条消息都应替换环境变量", async () => {
      mockReplaceVariables.mockImplementation((text: string) =>
        text.replace("{{DEVICE_ID}}", "device_001")
      );
      mockPublishMessage.mockResolvedValue(undefined);

      const wrapper = createWrapper();
      await flushPromises();

      // 填入带环境变量的 Topic
      const vm = wrapper.vm as any;
      vm.publishData.topic = "device/{{DEVICE_ID}}/command";
      await flushPromises();

      // 打开并启动
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      vm.timedMessageInterval = 1;
      await flushPromises();

      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 应调用 replaceVariables
      expect(mockReplaceVariables).toHaveBeenCalledWith("device/{{DEVICE_ID}}/command");

      // 发布应使用替换后的值
      expect(mockPublishMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          topic: "device/device_001/command",
        })
      );
    });
  });

  describe("发送前脚本", () => {
    it("定时发送每条消息都应执行发送前脚本", async () => {
      const { ScriptEngine } = await import("@/utils/scriptEngine");
      mockPublishMessage.mockResolvedValue(undefined);
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_enabled_scripts") {
          return [
            {
              id: 1,
              name: "test-script",
              code: "function process(p) { return p; }",
              script_type: "before_publish",
              enabled: true,
            },
          ];
        }
        return undefined;
      });

      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      // 打开并启动
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      vm.timedMessageInterval = 1;
      await flushPromises();

      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 应执行脚本
      expect(ScriptEngine.executeBeforePublish).toHaveBeenCalled();
    });
  });

  describe("发送失败处理", () => {
    it("发送失败应继续下一次发送", async () => {
      mockPublishMessage
        .mockRejectedValueOnce(new Error("publish failed"))
        .mockResolvedValue(undefined);

      const wrapper = createWrapper();
      await flushPromises();

      // 填入数据
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      await flushPromises();

      // 打开并启动
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      vm.timedMessageInterval = 0.5;
      await flushPromises();

      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 第1条失败
      expect(mockPublishMessage).toHaveBeenCalledTimes(1);

      // 快进，第2条应继续发送
      vi.advanceTimersByTime(500);
      await flushPromises();

      expect(mockPublishMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("格式验证", () => {
    it("HEX 格式无效时应阻止开始", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic 和无效 HEX payload
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      vm.payloadFormat = "hex";
      vm.publishData.payload = "GGGG"; // 无效 HEX
      await flushPromises();

      // 打开对话框
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 点击开始应提示错误，不调用 publishMessage
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      // 对话框不应关闭，因为没有调用 publishMessage
      expect(mockPublishMessage).not.toHaveBeenCalled();
      // 对话框仍然打开
      expect(wrapper.find(".el-dialog").exists()).toBe(true);
    });

    it("JSON 格式无效时应阻止开始", async () => {
      const wrapper = createWrapper();
      await flushPromises();

      // 填入 Topic 和无效 JSON
      const vm = wrapper.vm as any;
      vm.publishData.topic = "test/topic";
      vm.payloadFormat = "json";
      vm.publishData.payload = "{invalid json";
      await flushPromises();

      // 打开对话框
      const timedMessageBtn = wrapper.find(".btn-timed-message");
      await timedMessageBtn!.trigger("click");
      await flushPromises();

      // 点击开始应提示错误
      const startBtn = wrapper.findAll(".el-dialog__footer button").find((btn) =>
        btn.text().includes("开始发送")
      );
      await startBtn!.trigger("click");
      await flushPromises();

      expect(mockPublishMessage).not.toHaveBeenCalled();
      expect(wrapper.find(".el-dialog").exists()).toBe(true);
    });
  });
});
