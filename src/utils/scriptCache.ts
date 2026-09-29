import { invoke } from "@tauri-apps/api/core";
import type { Script, ScriptType } from "@/stores/script";
import { FifoCache } from "@/utils/fifoCache";

export const SCRIPT_CACHE_TTL_MS = 5000;
export const SCRIPT_CACHE_MAX_ENTRIES = 100;

type ScriptLoader = (serverId: number, scriptType: ScriptType) => Promise<Script[]>;

interface CachedScripts {
  scripts: Script[];
  timestamp: number;
}

const SCRIPT_TYPES: readonly ScriptType[] = ["before_publish", "after_receive"];

export class ScriptCache {
  private readonly scripts: FifoCache<string, CachedScripts>;
  private readonly inFlight = new Map<string, Promise<Script[]>>();

  constructor(
    private readonly loadScripts: ScriptLoader,
    maxEntries = SCRIPT_CACHE_MAX_ENTRIES,
    private readonly ttlMs = SCRIPT_CACHE_TTL_MS
  ) {
    this.scripts = new FifoCache(maxEntries);
  }

  get(serverId: number, scriptType: ScriptType): Promise<Script[]> {
    const key = this.key(serverId, scriptType);
    const cached = this.scripts.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return Promise.resolve(cached.scripts);
    }
    if (cached) this.scripts.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    let request: Promise<Script[]>;
    request = Promise.resolve()
      .then(() => this.loadScripts(serverId, scriptType))
      .then((scripts) => {
        if (this.inFlight.get(key) === request) {
          this.scripts.set(key, { scripts, timestamp: Date.now() });
        }
        return scripts;
      })
      .catch(() => [])
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  clear(serverId?: number): void {
    if (serverId === undefined) {
      this.scripts.clear();
      this.inFlight.clear();
      return;
    }

    for (const scriptType of SCRIPT_TYPES) {
      const key = this.key(serverId, scriptType);
      this.scripts.delete(key);
      this.inFlight.delete(key);
    }
  }

  private key(serverId: number, scriptType: ScriptType): string {
    return JSON.stringify([serverId, scriptType]);
  }
}

export const scriptCache = new ScriptCache((serverId, scriptType) =>
  invoke<Script[]>("get_enabled_scripts", { serverId, scriptType })
);

export const getCachedScripts = (serverId: number, scriptType: ScriptType) =>
  scriptCache.get(serverId, scriptType);

export const clearScriptCache = (serverId?: number) => scriptCache.clear(serverId);
