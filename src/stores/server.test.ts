import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "./server";
import { clearScriptCache, getCachedScripts } from "@/utils/scriptCache";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("useServerStore script cache invalidation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    clearScriptCache();
    vi.clearAllMocks();
  });

  it("clears only the removed server's scripts, including server ID zero", async () => {
    let loadCount = 0;
    mockedInvoke.mockImplementation(async (command: string, args?: any) => {
      if (command === "get_enabled_scripts") {
        loadCount += 1;
        return [
          {
            server_id: args.serverId,
            name: `script-${loadCount}`,
            script_type: args.scriptType,
            code: "",
            enabled: true,
          },
        ] as any;
      }
      return undefined as any;
    });

    const serverZeroBeforeDelete = await getCachedScripts(0, "before_publish");
    const serverOneBeforeDelete = await getCachedScripts(1, "before_publish");

    await useServerStore().removeServer(0);

    const serverZeroAfterDelete = await getCachedScripts(0, "before_publish");
    const serverOneAfterDelete = await getCachedScripts(1, "before_publish");

    expect(serverZeroAfterDelete[0].name).not.toBe(serverZeroBeforeDelete[0].name);
    expect(serverOneAfterDelete).toBe(serverOneBeforeDelete);
    expect(loadCount).toBe(3);
  });
});
