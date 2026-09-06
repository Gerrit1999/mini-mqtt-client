import { describe, expect, it } from "vitest";
import {
  PayloadCodecError,
  decodePayload,
  detectPayloadFormat,
  encodePayload,
  isValidUtf8,
} from "./payloadCodec";

describe("payloadCodec", () => {
  it("round-trips empty and UTF-8 payloads", () => {
    expect(decodePayload("", "base64")).toEqual(new Uint8Array());

    const bytes = decodePayload("你好 MQTT", "text");
    expect(encodePayload(bytes, "text")).toBe("你好 MQTT");
    expect(encodePayload(bytes, "base64")).toBe("5L2g5aW9IE1RVFQ=");
  });

  it("round-trips arbitrary binary bytes through Base64", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x0a]);
    const encoded = encodePayload(bytes, "base64");

    expect(encoded).toBe("AP+AQQo=");
    expect(decodePayload(encoded, "base64")).toEqual(bytes);
    expect(isValidUtf8(bytes)).toBe(false);
  });

  it("accepts missing Base64 padding and ASCII whitespace", () => {
    expect(decodePayload(" T W\nE\t", "base64")).toEqual(
      new Uint8Array([0x4d, 0x61])
    );
  });

  it.each(["%%", "TQ=", "TWFu=", "A", "Zh==", "TQ===", "TQ-_"])(
    "rejects invalid Base64 input %j",
    (input) => {
      expect(() => decodePayload(input, "base64")).toThrow(PayloadCodecError);
    }
  );

  it("validates and decodes HEX through the same interface", () => {
    expect(decodePayload("00 ff 80 41", "hex")).toEqual(
      new Uint8Array([0x00, 0xff, 0x80, 0x41])
    );
    expect(() => decodePayload("ABC", "hex")).toThrow(PayloadCodecError);
    expect(() => decodePayload("GG", "hex")).toThrow(PayloadCodecError);
  });

  it("validates JSON while preserving its original UTF-8 bytes", () => {
    const source = '{"id":9223372036854775807}';
    expect(encodePayload(decodePayload(source, "json"), "text")).toBe(source);
    expect(() => decodePayload("{invalid", "json")).toThrow(PayloadCodecError);
    expect(Array.from(decodePayload("", "json"))).toEqual([]);
  });

  it("detects JSON, text, and binary payloads", () => {
    expect(detectPayloadFormat(new TextEncoder().encode('{"ok":true}'))).toBe("json");
    expect(detectPayloadFormat(new TextEncoder().encode("plain text"))).toBe("text");
    expect(detectPayloadFormat(new Uint8Array([0x00, 0xff, 0x80]))).toBe("hex");
  });

  it("encodes large byte arrays without overflowing the call stack", () => {
    const bytes = new Uint8Array(200_000);
    bytes[199_999] = 0xff;

    const encoded = encodePayload(bytes, "base64");
    expect(decodePayload(encoded, "base64")).toEqual(bytes);
  });
});
