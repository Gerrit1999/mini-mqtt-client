import { describe, expect, it } from "vitest";
import { createMessageIdentity } from "./messageIdentity";
import type { MqttMessage } from "@/types/mqtt";

const message = (patch: Partial<MqttMessage> = {}): MqttMessage => ({
  server_id: 1, direction: "receive", topic: "same", payload: new Uint8Array([65]),
  qos: 0, retain: false, timestamp: "2026-10-09", ...patch,
});

describe("message identity", () => {
  it("retains a history-first key through live replacement and disappearance", () => {
    const identity = createMessageIdentity();
    const history = message({ id: 42 });
    const first = identity.merge([history], []);
    const before = identity.key(first[0]);
    const live = message({ id: 42, seq: 10 });
    for (const realtime of [[live], [{ ...live }], []]) {
      const merged = identity.merge([{ ...history }], realtime);
      expect(merged).toHaveLength(1);
      expect(identity.key(merged[0])).toBe(before);
    }
  });

  it("retains live-first seq identity through replacement, assigned id and history-only reload", () => {
    const identity = createMessageIdentity();
    const live = message({ seq: 11 });
    const before = identity.key(identity.merge([], [live])[0]);
    identity.key(message({ id: 17 }));
    const merged = identity.merge([message({ id: 17 })], [{ ...live, id: 17 }]);
    expect(merged).toHaveLength(1);
    expect(identity.key(merged[0])).toBe(before);
    expect(identity.key(identity.merge([message({ id: 17 })], [])[0])).toBe(before);
  });

  it("releases sequence aliases when their records leave the loaded window", () => {
    const identity = createMessageIdentity();
    identity.merge([message({ id: 42 })], []);
    const merged = identity.merge([message({ id: 42 })], [message({ id: 42, seq: 10 })]);
    expect(identity.key(merged[0])).toBe(JSON.stringify([1, "id", 42]));
    identity.merge([], []);
    expect(identity.key(message({ seq: 10 }))).toBe(JSON.stringify([1, "seq", 10]));
  });

  it("separates server, persistence, operation, seq and anonymous namespaces", () => {
    const identity = createMessageIdentity();
    const rows = [message({ id: 1 }), message({ seq: 1 }), message({ operation_id: "1" }),
      message({ server_id: 2, id: 1 }), message(), message()];
    expect(new Set(rows.map(identity.key)).size).toBe(rows.length);
    expect(identity.merge([], rows)).toHaveLength(rows.length);
  });

  it("retains a live key when an id is assigned and merges the history alias", () => {
    const identity = createMessageIdentity();
    const live = message({ seq: 0 });
    const before = identity.key(live);
    live.id = 42;
    expect(identity.key(live)).toBe(before);
    const merged = identity.merge([message({ id: 42 })], [live]);
    expect(merged).toHaveLength(1);
    expect(identity.key(merged[0])).toBe(before);
  });

  it("survives replaced publish objects and retains the most advanced status", () => {
    const identity = createMessageIdentity();
    const pending = message({ operation_id: "op", seq: 4, publish_status: "pending" });
    const before = identity.key(pending);
    const confirmed = message({ id: 9, operation_id: "op", publish_status: "confirmed" });
    const merged = identity.merge([confirmed], [{ ...pending, id: 9, publish_status: "sent" }]);
    expect(merged).toHaveLength(1);
    expect(identity.key(merged[0])).toBe(before);
    expect(merged[0].publish_status).toBe("confirmed");
  });

  it("deduplicates by id even when an already-rendered history record gains an operation alias", () => {
    const identity = createMessageIdentity();
    const history = message({ id: 5 });
    identity.merge([history], []);
    const live = message({ operation_id: "new-op", seq: 8 });
    const before = identity.key(live);
    live.id = 5;
    const merged = identity.merge([history], [live]);
    expect(merged).toHaveLength(1);
    expect(identity.key(merged[0])).toBe(before);
  });

  it("deduplicates repeated SQLite ids without collapsing anonymous history", () => {
    const identity = createMessageIdentity();
    expect(identity.merge([message({ id: 2 }), message({ id: 2 }), message(), message()], [])).toHaveLength(3);
  });

  it("retains seq identity across object replacement even if history registered the new id", () => {
    const identity = createMessageIdentity();
    const live = message({ seq: 11 });
    const before = identity.key(live);
    identity.key(message({ id: 17 }));
    expect(identity.key({ ...live, id: 17 })).toBe(before);
  });
});
