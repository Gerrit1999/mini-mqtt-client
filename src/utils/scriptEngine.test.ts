import { describe, expect, it } from "vitest";
import { ScriptEngine } from "./scriptEngine";
import { gzip } from "pako";
import type { Script } from "@/stores/script";

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
    expect(result).toMatch(/^YWFhYWFh.*YWE=$/);
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
      compressedBytes,
      "test/topic"
    );

    expect(result).toBe("AP8BQQ==");
  });
});

describe("ScriptEngine payload chains", () => {
  function scripts(...codes: string[]): Script[] {
    return codes.map((code, id) => ({
      id, server_id: 1, name: `transform ${id}`, code, script_type: "after_receive", enabled: true,
    }));
  }

  it("recomputes payloadBytes after a text result and carries a byte view through later scripts", async () => {
    const result = await ScriptEngine.executeAfterReceive(
      scripts(
        'return "中";',
        'if (payload !== "中" || crypto.bytesToHex(payloadBytes) !== "e4b8ad") throw new Error("stale payload");\n' +
        'return new Uint8Array([1, 0, 255, 128, 2]).subarray(1, 4);',
        'if (crypto.bytesToHex(payloadBytes) !== "00ff80") throw new Error("stale bytes"); return payload;'
      ),
      new Uint8Array([255]),
      "test/topic"
    );

    expect(result).toEqual(new Uint8Array([0, 255, 128]));
  });

  it.each(["payload", "null", "undefined"])("preserves input bytes when returning %s", async (value) => {
    const input = new Uint8Array([0, 255, 128]);
    const result = await ScriptEngine.executeAfterReceive(
      scripts(`payloadBytes.fill(42); return ${value};`), input, "test/topic"
    );

    expect(result).toEqual(new Uint8Array([0, 255, 128]));
    expect(input).toEqual(new Uint8Array([0, 255, 128]));
  });

  it.each([
    ['return "";', ""],
    ['return { ready: true };', '{"ready":true}'],
    ['return false;', "false"],
  ])("normalizes %s as text", async (code, expected) => {
    expect(await ScriptEngine.executeAfterReceive(scripts(code), new Uint8Array([255]), "test/topic"))
      .toBe(expected);
  });
});

describe("ScriptEngine script validation", () => {
  it.each([
    { code: 'throw "raw reason"', cause: "raw reason" },
    { code: 'throw { message: "raw reason", code: "TRANSFORM" }', cause: { message: "raw reason", code: "TRANSFORM" } },
  ])("forwards non-Error script causes without requiring a persisted script ID: $code", async ({ code, cause }) => {
    const script = { server_id: 1, name: "unsaved transform", code, enabled: true, script_type: "before_publish" as const };
    await expect(ScriptEngine.executeBeforePublish([script], "body", "topic")).rejects.toMatchObject({
      message: "raw reason", cause, scriptName: "unsaved transform", scriptId: undefined,
    });
  });

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
