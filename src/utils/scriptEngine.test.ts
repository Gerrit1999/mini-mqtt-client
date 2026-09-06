import { describe, expect, it } from "vitest";
import { ScriptEngine } from "./scriptEngine";

describe("ScriptEngine payload codecs", () => {
  it("encodes a 200KB payload as Base64 without overflowing the call stack", async () => {
    const payload = "a".repeat(200_000);
    const result = await ScriptEngine.executeBeforePublish(
      [
        {
          id: 1,
          server_id: 1,
          name: "base64-large-payload",
          code: "function process(payload) { return crypto.bytesToBase64(crypto.stringToBytes(payload)); }",
          script_type: "before_publish",
          enabled: true,
        },
      ],
      payload,
      "test/topic"
    );

    expect(result).toHaveLength(266_668);
    expect(result.startsWith("YWFhYWFh")).toBe(true);
    expect(result.endsWith("YWE=")).toBe(true);
  });
});
