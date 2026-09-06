import type { PayloadFormat } from "@/types/mqtt";

export type DetectedPayloadFormat = "text" | "json" | "hex";
export type PayloadCodecErrorCode = "invalid-json" | "invalid-hex" | "invalid-base64";

export class PayloadCodecError extends Error {
  constructor(
    public readonly format: PayloadFormat,
    public readonly code: PayloadCodecErrorCode
  ) {
    super(`Invalid ${format.toUpperCase()} payload`);
    this.name = "PayloadCodecError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ASCII_WHITESPACE = /[\t\n\f\r ]/g;
const BASE64_CHUNK_SIZE = 0x8000;

function decodeHex(source: string): Uint8Array {
  const normalized = source.replace(ASCII_WHITESPACE, "");
  if (normalized.length % 2 !== 0 || /[^0-9a-fA-F]/.test(normalized)) {
    throw new PayloadCodecError("hex", "invalid-hex");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function decodeBase64(source: string): Uint8Array {
  const normalized = source.replace(ASCII_WHITESPACE, "");
  if (normalized.length === 0) return new Uint8Array();
  if (/[^A-Za-z0-9+/=]/.test(normalized)) {
    throw new PayloadCodecError("base64", "invalid-base64");
  }

  const paddingIndex = normalized.indexOf("=");
  const body = paddingIndex === -1 ? normalized : normalized.slice(0, paddingIndex);
  const padding = paddingIndex === -1 ? "" : normalized.slice(paddingIndex);
  if ((padding && !/^={1,2}$/.test(padding)) || body.length % 4 === 1) {
    throw new PayloadCodecError("base64", "invalid-base64");
  }

  const expectedPadding = (4 - (body.length % 4)) % 4;
  if (padding.length !== 0 && padding.length !== expectedPadding) {
    throw new PayloadCodecError("base64", "invalid-base64");
  }

  try {
    const decoded = atob(body + "=".repeat(expectedPadding));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (encodeBase64(bytes).replace(/=+$/, "") !== body) {
      throw new PayloadCodecError("base64", "invalid-base64");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PayloadCodecError) throw error;
    throw new PayloadCodecError("base64", "invalid-base64");
  }
}

export function decodePayload(source: string, format: PayloadFormat): Uint8Array {
  switch (format) {
    case "text":
      return textEncoder.encode(source);
    case "json":
      if (source.trim()) {
        try {
          JSON.parse(source);
        } catch {
          throw new PayloadCodecError("json", "invalid-json");
        }
      }
      return textEncoder.encode(source);
    case "hex":
      return decodeHex(source);
    case "base64":
      return decodeBase64(source);
  }
}

export function encodePayload(bytes: Uint8Array, format: PayloadFormat): string {
  switch (format) {
    case "text":
    case "json":
      return textDecoder.decode(bytes);
    case "hex":
      return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
        .join("");
    case "base64":
      return encodeBase64(bytes);
  }
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectPayloadFormat(bytes: Uint8Array): DetectedPayloadFormat {
  if (bytes.length === 0 || !isValidUtf8(bytes)) {
    return bytes.length === 0 ? "text" : "hex";
  }

  const text = textDecoder.decode(bytes);
  const trimmed = text.trim();
  if (
    trimmed &&
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Continue with text detection.
    }
  }

  const nonPrintable = Array.from(text).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint < 32 || codePoint === 127) && character !== "\t" && character !== "\n" && character !== "\r";
  }).length;

  return nonPrintable / Array.from(text).length > 0.1 ? "hex" : "text";
}
