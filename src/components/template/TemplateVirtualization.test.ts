import { invoke } from "@tauri-apps/api/core";
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import { GLOBAL_TEMPLATE_SERVER_ID, type CommandTemplate } from "@/stores/template";
import TemplateDialog from "./TemplateDialog.vue";
import TemplateDrawer from "./TemplateDrawer.vue";
import TemplateList from "./TemplateList.vue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function makeTemplates(): CommandTemplate[] {
  return Array.from({ length: 2000 }, (_, index) => ({
    id: index + 1,
    server_id: index === 1999 ? GLOBAL_TEMPLATE_SERVER_ID : 1,
    name: `Template ${index + 1}`,
    topic: `device/${index + 1}`,
    payload: "hello",
    payload_type: "text",
    qos: 0,
    retain: false,
    use_count: 0,
    category: index === 1999 ? "Tail" : "Default",
  }));
}

function mountOptions() {
  return {
    props: { serverId: 1 },
    attachTo: document.body,
    global: {
      plugins: [
        ElementPlus,
        createPinia(),
        createI18n({ legacy: false, locale: "en", missing: (_locale, key) => key }),
      ],
    },
  };
}

describe("virtualized template management", () => {
  beforeEach(() => {
    // Supply layout dimensions while exercising the real virtualizer in jsdom.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("virtual-list")) return 400;
        if (this.classList.contains("virtual-row")) return 152;
        return 0;
      });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_templates") return makeTemplates();
      if (command === "get_template_categories") return ["Default", "Tail"];
      return undefined;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    { component: TemplateList, rowSelector: ".table-data" },
    { component: TemplateDrawer, rowSelector: ".template-card" },
  ])("renders a bounded window and finds a result when filtering from the tail", async ({ component, rowSelector }) => {
    const wrapper = mount(component, mountOptions());
    try {
      await flushPromises();
      const list = wrapper.get(".virtual-list");
      expect(list.findAll(rowSelector).length).toBeLessThan(18);
      expect(list.findAll(rowSelector)[0].text()).toContain("Template 1");

      await list.trigger("keydown", { key: "End" });
      expect(document.activeElement?.textContent).toContain("Template 2000");
      expect(document.activeElement?.textContent).toContain("template.global");

      await wrapper.get('input[placeholder="template.searchPlaceholder"]').setValue("Template 1998");
      expect(list.findAll(rowSelector).map(row => row.text())).toEqual([
        expect.stringContaining("Template 1998"),
      ]);
    } finally {
      wrapper.unmount();
    }
  });

  it("edits and deletes the template focused at the end of the table", async () => {
    const wrapper = mount(TemplateList, mountOptions());
    try {
      await flushPromises();
      const list = wrapper.get(".virtual-list");
      await list.trigger("keydown", { key: "End" });
      await list.get('button[aria-label="common.edit Template 2000"]').trigger("click");
      expect(wrapper.getComponent(TemplateDialog).props("template")).toMatchObject({ id: 2000 });

      await wrapper.getComponent(TemplateDialog).vm.$emit("update:visible", false);
      await list.trigger("keydown", { key: "End" });
      await list.get('button[aria-label="common.delete Template 2000"]').trigger("click");
      await flushPromises();
      const confirm = document.querySelector<HTMLButtonElement>(".el-message-box__btns .el-button--primary");
      expect(confirm).not.toBeNull();
      confirm?.click();
      await flushPromises();
      expect(invoke).toHaveBeenCalledWith("delete_template", { id: 2000 });
      expect(list.find('button[aria-label="common.delete Template 2000"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
