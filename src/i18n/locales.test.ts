import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateLocaleSources } from "../../scripts/i18n-validation";

const enUSYaml = readFileSync("src/i18n/locales/en-US.yaml", "utf8");
const zhCNYaml = readFileSync("src/i18n/locales/zh-CN.yaml", "utf8");

describe("locale validation", () => {
  it("validates both real locales, key parity and all message syntax", () => {
    expect(() => validateLocaleSources({ "en-US": enUSYaml, "zh-CN": zhCNYaml })).not.toThrow();
  });

  it("rejects invalid YAML with locale diagnostics", () => {
    expect(() => validateLocaleSources({ "zh-CN": "broken: [" })).toThrow(/zh-CN: invalid YAML/);
  });

  it.each(["42", "true", "null", "[hello]", "{}"])("rejects non-string value %s", value => {
    expect(() => validateLocaleSources({ "en-US": `common:\n  confirm: ${value}` })).toThrow(/en-US:common.confirm/);
  });

  it("rejects missing and extra keys", () => {
    expect(() => validateLocaleSources({ "en-US": "common:\n  confirm: Confirm", "zh-CN": "common:\n  cancel: 取消" }))
      .toThrow(/missing: common.confirm; extra: common.cancel/);
  });

  it.each(["Hello {name", "Hello {{name}}", "hello @:"])("rejects invalid message %s with key diagnostics", message => {
    expect(() => validateLocaleSources({ "en-US": `greeting: '${message}'` })).toThrow(/en-US:greeting: invalid message/);
  });

  it("rejects cyclic aliases", () => {
    expect(() => validateLocaleSources({ "en-US": "common: &common\n  nested: *common" })).toThrow(/cyclic YAML alias/);
  });
});
