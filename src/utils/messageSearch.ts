import type { MqttMessage } from "@/types/mqtt";
import { encodePayload } from "./payloadCodec";

export interface MessageSearchQuery {
  keyword: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export type MessageSearchRow = Pick<MqttMessage, "topic" | "payload">;

export interface MessageSearchBatch {
  query: MessageSearchQuery;
  rows: MessageSearchRow[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const emptyPayload = new Uint8Array();
const MAX_HIGHLIGHTS = 96;

export function buildMessageSearchRegex(query: MessageSearchQuery): RegExp | null {
  if (!query.keyword) return null;

  let pattern = query.useRegex ? query.keyword : query.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  try {
    return new RegExp(pattern, query.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

export function createMessageMatcher(query: MessageSearchQuery): (row: MessageSearchRow) => boolean {
  if (!query.keyword) return () => true;
  const regex = buildMessageSearchRegex(query);
  if (!regex) return () => false;

  const canMatchHex = query.useRegex || /^[0-9a-f ]+$/i.test(query.keyword);
  const canMatchBase64 = query.useRegex || /^[a-z0-9+/=]+$/i.test(query.keyword);
  const matches = (value: string) => {
    regex.lastIndex = 0;
    return regex.test(value);
  };

  return ({ topic, payload }) => {
    if (matches(topic)) return true;
    const bytes = typeof payload === "string" ? textEncoder.encode(payload) : payload ?? emptyPayload;
    return matches(textDecoder.decode(bytes)) ||
      (canMatchHex && matches(encodePayload(bytes, "hex").match(/.{2}/g)?.join(" ") ?? "")) ||
      (canMatchBase64 && matches(encodePayload(bytes, "base64")));
  };
}

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

export function highlightMessageText(text: string, regex: RegExp | null, scanLimit = text.length): string {
  if (!regex) return escapeHtml(text);

  const source = text.slice(0, scanLimit);
  let html = "";
  let end = 0;
  let highlights = 0;
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;

  while (highlights < MAX_HIGHLIGHTS && (match = regex.exec(source)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    html += escapeHtml(source.slice(end, match.index));
    html += `<mark class="search-highlight">${escapeHtml(match[0])}</mark>`;
    end = match.index + match[0].length;
    highlights++;
  }

  return html + escapeHtml(text.slice(end));
}
