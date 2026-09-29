import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useScriptStore } from "./script";
import { clearScriptCache, getCachedScripts } from "@/utils/scriptCache";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("useScriptStore cache invalidation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearScriptCache();
    vi.clearAllMocks();
  });

  it("invalidates both script types after create, update, delete, and toggle", async () => {
    let loadCount = 0;
    mockedInvoke.mockImplementation(async (command: string, args?: any) => {
      if (command === "get_enabled_scripts") {
        loadCount += 1;
        return [
          {
            id: loadCount,
            server_id: args.serverId,
            name: `script-${loadCount}`,
            script_type: args.scriptType,
            code: "function process(payload) { return payload; }",
            enabled: true,
          },
        ] as any;
      }
      if (command === "create_script") return 1 as any;
      if (command === "list_scripts") return [] as any;
      return undefined as any;
    });

    const store = useScriptStore();
    const readBothTypes = async () =>
      Promise.all([
        getCachedScripts(1, "before_publish"),
        getCachedScripts(1, "after_receive"),
      ]);

    const mutations = [
      () =>
        store.createScript({
          server_id: 1,
          name: "created",
          script_type: "before_publish",
          code: "",
          enabled: true,
        }),
      () => store.updateScript({ id: 1, code: "updated" }, 1),
      () => store.deleteScript(1, 1),
      () => store.toggleScript(1, true, 1),
      () => store.toggleScript(1, false, 1),
    ];

    let previousScripts = await readBothTypes();
    expect(loadCount).toBe(2);

    for (const mutate of mutations) {
      await mutate();
      const reloadedScripts = await readBothTypes();
      expect(reloadedScripts.map(([script]) => script.name)).not.toEqual(
        previousScripts.map(([script]) => script.name)
      );
      previousScripts = reloadedScripts;
    }

    expect(loadCount).toBe(12);
  });
});
