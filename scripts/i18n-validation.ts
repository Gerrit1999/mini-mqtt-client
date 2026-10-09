import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { baseCompile } from "@intlify/message-compiler";
import type { Plugin } from "vite";

// Build/test only: never import this module from application code.
export function validateLocaleSources(sources: Record<string, string>): void {
  const keysByLocale = Object.entries(sources).map(([locale, source]) => {
    let messages: unknown;
    try {
      messages = yaml.load(source);
    } catch (error) {
      throw new Error(`[i18n] ${locale}: invalid YAML: ${String(error)}`);
    }
    const keys: string[] = [];
    function visit(value: unknown, path: string, ancestors: Set<object>): void {
      if (typeof value === "string" && path) {
        baseCompile(value, {
          jit: true,
          onError(error) {
            throw new Error(`[i18n] ${locale}:${path}: invalid message: ${error.message}`);
          },
        });
        keys.push(path);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        if (ancestors.has(value)) throw new Error(`[i18n] ${locale}:${path}: cyclic YAML alias`);
        const entries = Object.entries(value);
        if (!entries.length) throw new Error(`[i18n] ${locale}:${path}: empty message object`);
        const next = new Set(ancestors).add(value);
        for (const [key, child] of entries) visit(child, path ? `${path}.${key}` : key, next);
      } else {
        throw new Error(`[i18n] ${locale}:${path || "<root>"}: expected a string message or nested object`);
      }
    }
    visit(messages, "", new Set());
    return { locale, keys: keys.sort() };
  });
  const [reference, ...others] = keysByLocale;
  for (const other of others) {
    const missing = reference.keys.filter(key => !other.keys.includes(key));
    const extra = other.keys.filter(key => !reference.keys.includes(key));
    if (missing.length || extra.length) {
      throw new Error(`[i18n] ${other.locale}: key mismatch with ${reference.locale}; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`);
    }
  }
}

export function validateLocalesPlugin(): Plugin {
  return {
    name: "validate-i18n-locales",
    buildStart() {
      const sources = Object.fromEntries(["en-US", "zh-CN"].map(locale => {
        const path = resolve("src/i18n/locales", `${locale}.yaml`);
        this.addWatchFile(path);
        return [locale, readFileSync(path, "utf8")];
      }));
      validateLocaleSources(sources);
    },
  };
}
