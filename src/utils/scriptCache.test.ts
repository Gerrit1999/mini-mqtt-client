import { describe, expect, it, vi } from "vitest";
import type { Script, ScriptType } from "@/stores/script";
import { ScriptCache } from "./scriptCache";

function createScript(serverId: number, scriptType: ScriptType, name: string): Script {
  return {
    server_id: serverId,
    name,
    script_type: scriptType,
    code: "function process(payload) { return payload; }",
    enabled: true,
  };
}

describe("ScriptCache", () => {
  it("isolates server and script-type entries and clears only the requested server", async () => {
    let loadCount = 0;
    const loadScripts = vi.fn(async (serverId: number, scriptType: ScriptType) => {
      loadCount += 1;
      return [createScript(serverId, scriptType, `${serverId}-${scriptType}-${loadCount}`)];
    });
    const cache = new ScriptCache(loadScripts, 10);

    await cache.get(1, "before_publish");
    await cache.get(1, "after_receive");
    const serverTwoScripts = await cache.get(2, "before_publish");
    cache.clear(1);

    await cache.get(1, "before_publish");
    await cache.get(1, "after_receive");
    expect(await cache.get(2, "before_publish")).toBe(serverTwoScripts);

    expect(loadScripts).toHaveBeenCalledTimes(5);
    expect(loadScripts.mock.calls.map(([serverId, type]) => [serverId, type])).toEqual([
      [1, "before_publish"],
      [1, "after_receive"],
      [2, "before_publish"],
      [1, "before_publish"],
      [1, "after_receive"],
    ]);
  });

  it("reuses one in-flight Promise for concurrent identical loads", async () => {
    let resolveLoad!: (scripts: Script[]) => void;
    const loadScripts = vi.fn(
      () => new Promise<Script[]>((resolve) => { resolveLoad = resolve; })
    );
    const cache = new ScriptCache(loadScripts);

    const first = cache.get(1, "before_publish");
    const second = cache.get(1, "before_publish");

    expect(first).toBe(second);
    await Promise.resolve();
    expect(loadScripts).toHaveBeenCalledTimes(1);

    const scripts = [createScript(1, "before_publish", "shared")];
    resolveLoad(scripts);
    await expect(first).resolves.toBe(scripts);
  });

  it("does not cache an in-flight result after that server is invalidated", async () => {
    const resolvers: Array<(scripts: Script[]) => void> = [];
    const loadScripts = vi.fn(
      () => new Promise<Script[]>((resolve) => { resolvers.push(resolve); })
    );
    const cache = new ScriptCache(loadScripts);

    const staleRequest = cache.get(1, "before_publish");
    await Promise.resolve();
    cache.clear(1);
    const freshRequest = cache.get(1, "before_publish");
    await Promise.resolve();

    resolvers[0]([createScript(1, "before_publish", "stale")]);
    await staleRequest;
    resolvers[1]([createScript(1, "before_publish", "fresh")]);
    await freshRequest;

    expect((await cache.get(1, "before_publish"))[0].name).toBe("fresh");
    expect(loadScripts).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest script entry when its configured bound is reached", async () => {
    let loadCount = 0;
    const loadScripts = vi.fn(async (serverId: number, scriptType: ScriptType) => {
      loadCount += 1;
      return [createScript(serverId, scriptType, `load-${loadCount}`)];
    });
    const cache = new ScriptCache(loadScripts, 2);

    const first = await cache.get(1, "before_publish");
    await cache.get(2, "before_publish");
    await cache.get(1, "before_publish");
    await cache.get(3, "before_publish");

    expect((await cache.get(2, "before_publish"))[0].name).toBe("load-2");
    expect((await cache.get(1, "before_publish"))[0].name).not.toBe(first[0].name);
    expect(loadScripts).toHaveBeenCalledTimes(4);
  });
});
