import { describe, expect, it } from "vitest";
import { ScriptEngine } from "./scriptEngine";
import { gzip } from "pako";

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

  it("keeps binary payloadBytes available to compression helpers", async () => {
    const originalBytes = new Uint8Array([0x00, 0xff, 0x01, 0x41]);
    const compressedBytes = gzip(originalBytes);
    const result = await ScriptEngine.executeAfterReceive(
      [
        {
          id: 2,
          server_id: 1,
          name: "gzip-payload",
          code: "function process() { return crypto.bytesToBase64(pako.ungzip(payloadBytes)); }",
          script_type: "after_receive",
          enabled: true,
        },
      ],
      new TextDecoder().decode(compressedBytes),
      "test/topic",
      undefined,
      compressedBytes
    );

    expect(result).toBe("AP8BQQ==");
  });
});

describe("ScriptEngine script validation", () => {
  it("accepts synchronous and asynchronous script syntax", () => {
    expect(ScriptEngine.validateScript("function process(payload) { return payload; }")).toBeNull();
    expect(ScriptEngine.validateScript("async function process(payload) { return payload; }")).toBeNull();
  });

  it("accepts top-level await in the async execution body", () => {
    const code = "const value = await Promise.resolve('ready'); function process() { return value; }";

    expect(ScriptEngine.validateScript(code)).toBeNull();
  });

  it("executes scripts with top-level await", async () => {
    const result = await ScriptEngine.executeBeforePublish(
      [
        {
          id: 3,
          server_id: 1,
          name: "top-level-await",
          code: "const value = await Promise.resolve('ready'); function process() { return value; }",
          script_type: "before_publish",
          enabled: true,
        },
      ],
      "original",
      "test/topic"
    );

    expect(result).toBe("ready");
  });

  it("still reports invalid syntax", () => {
    expect(ScriptEngine.validateScript("function process( { return payload; }")).toBeTruthy();
  });
});
