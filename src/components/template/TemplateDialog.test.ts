import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import TemplateDialog from "./TemplateDialog.vue";

const mockCreateTemplate = vi.fn();
const mockUpdateTemplate = vi.fn();

vi.mock("@/stores/template", () => ({
  GLOBAL_TEMPLATE_SERVER_ID: 0,
  useTemplateStore: () => ({
    createTemplate: mockCreateTemplate,
    updateTemplate: mockUpdateTemplate,
  }),
}));

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
      "zh-CN": {
        common: { cancel: "取消", save: "保存" },
        errors: {
          inputName: "请输入名称",
          inputTopic: "请输入 Topic",
          inputPayload: "请输入 Payload",
          jsonInvalid: "JSON 格式无效",
          hexInvalid: "HEX 格式无效",
          base64Invalid: "Base64 格式无效",
          saveFailed: "保存失败",
        },
        publish: {
          payload: "Payload",
          payloadPlaceholder: "请输入消息内容",
          topic: "Topic",
          topicPlaceholder: "请输入 Topic",
          retain: "保留消息",
        },
        script: {
          editScript: "编辑",
          description: "描述",
          descriptionPlaceholder: "请输入描述",
        },
        template: {
          addTemplate: "添加模板",
          name: "名称",
          namePlaceholder: "请输入名称",
          category: "分类",
          categoryPlaceholder: "请选择分类",
          saveToCurrentConnectionOnly: "仅当前连接",
          format: "格式化",
          minify: "压缩",
        },
      },
    },
  });
}

describe("TemplateDialog Base64 payload", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  function createWrapper() {
    return mount(TemplateDialog, {
      props: {
        visible: true,
        template: null,
        serverId: 1,
        categories: [],
      },
      global: {
        plugins: [ElementPlus, createTestI18n()],
      },
      attachTo: document.body,
    });
  }

  it("provides a Base64 format option", async () => {
    const wrapper = createWrapper();
    await flushPromises();

    expect(wrapper.find(".type-selector").text()).toContain("Base64");
    wrapper.unmount();
  });

  it("uses the shared Base64 validation rules", async () => {
    const wrapper = createWrapper();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.form.payload_type = "base64";

    vm.form.payload = "SGVs\n bG8";
    expect(vm.validatePayload()).toBe(true);

    vm.form.payload = "not base64!";
    expect(vm.validatePayload()).toBe(false);
    expect(vm.payloadError).toBe("Base64 格式无效");
    wrapper.unmount();
  });
});
