import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import i18n, * as locales from "@/i18n";
import { useAppStore } from "./app";

describe("app locale preferences", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    i18n.global.locale.value = "en-US";
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-TW");
  });
  afterEach(() => vi.restoreAllMocks());

  it("switches real messages and persists the preference for a new store", async () => {
    const app = useAppStore();
    await app.setLocale("zh-CN");
    expect(app.actualLocale).toBe("zh-CN");
    expect(app.getDateLocale()).toBe("zh-CN");
    expect(i18n.global.t("common.confirm")).toBe("确定");
    expect(localStorage.getItem("mqtt-client-locale")).toBe("zh-CN");
    setActivePinia(createPinia());
    const restored = useAppStore();
    await restored.initLocale();
    expect(restored.locale).toBe("zh-CN");
    expect(restored.actualLocale).toBe("zh-CN");
    await restored.setLocale("en-US");
    expect(restored.getDateLocale()).toBe("en-US");
    expect(i18n.global.t("common.confirm")).toBe("Confirm");
    expect(localStorage.getItem("mqtt-client-locale")).toBe("en-US");
  });

  it.each([null, "invalid", "auto"])("follows the system for preference %s", async stored => {
    if (stored) localStorage.setItem("mqtt-client-locale", stored);
    const app = useAppStore();
    await app.initLocale();
    expect(app.locale).toBe("auto");
    expect(app.actualLocale).toBe("zh-CN");
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    await app.setLocale("auto");
    expect(app.actualLocale).toBe("en-US");
    expect(localStorage.getItem("mqtt-client-locale")).toBe("auto");
  });

  it("preserves requested settings while displaying fallback after load failure", async () => {
    vi.spyOn(locales, "loadLocaleMessages").mockResolvedValue("en-US");
    localStorage.setItem("mqtt-client-locale", "zh-CN");
    const app = useAppStore();
    await app.initLocale();
    expect(app.locale).toBe("zh-CN");
    expect(app.actualLocale).toBe("en-US");
    expect(app.getDateLocale()).toBe("en-US");
    expect(localStorage.getItem("mqtt-client-locale")).toBe("zh-CN");
    expect(i18n.global.t("common.confirm")).toBe("Confirm");
  });

  it.each(["zh-CN", "en-US"] as const)("ignores a stale Chinese load resolving as %s", async result => {
    let resolve!: (locale: locales.ActualLocale) => void;
    vi.spyOn(locales, "loadLocaleMessages").mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const app = useAppStore();
    const first = app.setLocale("zh-CN");
    expect(app.actualLocale).toBe("en-US");
    await app.setLocale("en-US");
    resolve(result);
    await first;
    expect(app.locale).toBe("en-US");
    expect(app.actualLocale).toBe("en-US");
    expect(i18n.global.locale.value).toBe("en-US");
    expect(localStorage.getItem("mqtt-client-locale")).toBe("en-US");
  });
});
