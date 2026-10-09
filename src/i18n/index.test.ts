import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import ElementPlus, { ElPagination } from "element-plus";

afterEach(() => {
  vi.doUnmock("./locales/zh-CN.yaml");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("precompiled locales", () => {
  it("keeps Element Plus controls in the displayed language during switching and fallback", async () => {
    const { default: i18n, loadLocaleMessages } = await import("./index");
    const { elementPlusLocaleOptions } = await import("./element-plus");
    const view = mount(ElPagination, {
      props: { layout: "jumper", total: 100 },
      global: { plugins: [[ElementPlus, elementPlusLocaleOptions]] },
    });
    expect(view.text()).toContain("Go to");
    i18n.global.locale.value = await loadLocaleMessages("zh-CN");
    await nextTick();
    expect(view.text()).toContain("前往");
    i18n.global.locale.value = "en-US";
    await nextTick();
    expect(view.text()).toContain("Go to");
    view.unmount();
  });

  it("renders real AST messages, interpolation and literal braces", async () => {
    const { default: i18n, loadLocaleMessages } = await import("./index");
    expect(i18n.global.t("common.confirm")).toBe("Confirm");
    expect(i18n.global.t("header.status.reconnecting", { attempt: 3 })).toBe("Reconnecting · attempt 3");
    expect(i18n.global.t("script.envFunctions.replace")).toBe("Replace {{var}} placeholders in text");
    const en = await import("./locales/en-US.yaml");
    expect(en.default).toHaveProperty("common.confirm.type", 0);
    expect(await loadLocaleMessages("zh-CN")).toBe("zh-CN");
    expect(i18n.global.locale.value).toBe("en-US");
    i18n.global.locale.value = "zh-CN";
    expect(i18n.global.t("common.confirm")).toBe("确定");
    expect(i18n.global.t("header.status.reconnecting", { attempt: 3 })).toBe("正在重连 · 第 3 次");
    expect(i18n.global.t("script.envFunctions.replace")).toBe("替换文本中的 {{变量名}} 占位符");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    i18n.global.setLocaleMessage("zh-CN", {});
    expect(i18n.global.t("common.confirm")).toBe("Confirm");
  });

  it("keeps a rendered default UI and actionable diagnostics when Chinese fails", async () => {
    const failure = new Error("locale asset unavailable");
    vi.doMock("./locales/zh-CN.yaml", () => { throw failure; });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: i18n, loadLocaleMessages } = await import("./index");
    const view = mount(defineComponent({ template: "<button>{{ $t('common.confirm') }}</button>" }), {
      global: { plugins: [i18n] },
    });
    expect(await loadLocaleMessages("zh-CN")).toBe("en-US");
    expect(view.text()).toBe("Confirm");
    expect(i18n.global.availableLocales).toEqual(["en-US"]);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/zh-CN.*en-US.*select the language again/), expect.anything());
    await loadLocaleMessages("zh-CN");
    expect(diagnostic).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("shares an in-flight Chinese load", async () => {
    let resolve!: (messages: { default: object }) => void;
    const loader = vi.fn(() => new Promise<{ default: object }>(yes => { resolve = yes; }));
    vi.doMock("./locales/zh-CN.yaml", loader);
    const { loadLocaleMessages } = await import("./index");
    const first = loadLocaleMessages("zh-CN");
    const second = loadLocaleMessages("zh-CN");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    resolve({ default: {} });
    expect(await first).toBe("zh-CN");
    expect(await second).toBe("zh-CN");
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
