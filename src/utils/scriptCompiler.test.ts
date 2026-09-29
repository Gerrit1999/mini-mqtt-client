import { describe, expect, it, vi } from "vitest";
import { ScriptCompilerCache } from "./scriptCompiler";

describe("ScriptCompilerCache", () => {
  it("reuses compiled scripts and evicts the oldest entry at its bound", () => {
    const compileScript = vi.fn(
      (code: string) => async () => code
    );
    const cache = new ScriptCompilerCache(compileScript, 2);

    const first = cache.get("first");
    const second = cache.get("second");
    expect(cache.get("first")).toBe(first);
    cache.get("third");

    expect(cache.get("second")).toBe(second);
    expect(cache.get("first")).not.toBe(first);
    expect(compileScript).toHaveBeenCalledTimes(4);
  });
});
