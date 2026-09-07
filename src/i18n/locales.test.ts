import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import enUSYaml from "./locales/en-US.yaml?raw";
import zhCNYaml from "./locales/zh-CN.yaml?raw";

describe("locale YAML", () => {
  it.each([
    ["en-US", enUSYaml],
    ["zh-CN", zhCNYaml],
  ])("parses the %s locale", (_locale, source) => {
    expect(() => yaml.load(source)).not.toThrow();
  });
});
