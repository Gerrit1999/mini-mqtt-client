import { createMessageMatcher, type MessageSearchBatch } from "../utils/messageSearch";

self.onmessage = ({ data }: MessageEvent<MessageSearchBatch>) => {
  self.postMessage(data.rows.map(createMessageMatcher(data.query)));
};
