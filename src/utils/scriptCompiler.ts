import { FifoCache } from "@/utils/fifoCache";

type CompiledScript = (...args: unknown[]) => Promise<unknown>;

export const SCRIPT_COMPILE_CACHE_MAX_ENTRIES = 100;

export class ScriptCompilerCache {
  private readonly scripts: FifoCache<string, CompiledScript>;

  constructor(
    private readonly compileScript: (code: string) => CompiledScript,
    maxEntries = SCRIPT_COMPILE_CACHE_MAX_ENTRIES
  ) {
    this.scripts = new FifoCache(maxEntries);
  }

  get(code: string): CompiledScript {
    const cached = this.scripts.get(code);
    if (cached) return cached;

    const compiled = this.compileScript(code);
    this.scripts.set(code, compiled);
    return compiled;
  }
}
