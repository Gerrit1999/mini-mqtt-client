import type { MqttMessage } from "@/types/mqtt";

let nextTransientId = 0;

/** Persistence aliases deduplicate records; object/session identity keeps DOM keys stable. */
export function createMessageIdentity() {
  const objects = new WeakMap<object, string>();
  const aliases = new Map<string, string>();

  function persistenceKeys(message: MqttMessage): string[] {
    const keys: string[] = [];
    if (message.operation_id) keys.push(JSON.stringify([message.server_id, "operation", message.operation_id]));
    if (message.id !== undefined) keys.push(JSON.stringify([message.server_id, "id", message.id]));
    return keys;
  }

  function identityKeys(message: MqttMessage): string[] {
    // A known session sequence wins over an id registered later by history.
    return [...(message.seq !== undefined ? [JSON.stringify([message.server_id, "seq", message.seq])] : []),
      ...persistenceKeys(message)];
  }

  function bind(message: MqttMessage, key: string) {
    objects.set(message, key);
    for (const alias of identityKeys(message)) aliases.set(alias, key);
    return key;
  }

  function key(message: MqttMessage): string {
    const existing = objects.get(message);
    const known = identityKeys(message).map((alias) => aliases.get(alias)).find(Boolean);
    return bind(message, existing ?? known ?? (
      message.operation_id ? JSON.stringify([message.server_id, "operation", message.operation_id]) :
      message.seq !== undefined ? JSON.stringify([message.server_id, "seq", message.seq]) :
      message.id !== undefined ? JSON.stringify([message.server_id, "id", message.id]) :
      JSON.stringify([message.server_id, "transient", nextTransientId++])
    ));
  }

  function merge(history: MqttMessage[], realtime: MqttMessage[]): MqttMessage[] {
    // Register live objects first: assigning a SQLite id must not replace their key.
    realtime.forEach(key);
    const records: MqttMessage[] = [];
    const recordAliases = new Map<string, number>();
    function register(message: MqttMessage, index: number) {
      for (const alias of persistenceKeys(message)) recordAliases.set(alias, index);
    }
    for (const message of history) {
      const index = persistenceKeys(message).map((alias) => recordAliases.get(alias))
        .find((value) => value !== undefined);
      const renderKey = key(message);
      if (index !== undefined) {
        bind(message, key(records[index]));
        records[index] = message;
        register(message, index);
      } else {
        bind(message, renderKey);
        register(message, records.length);
        records.push(message);
      }
    }
    const rank = { pending: 0, sent: 1, confirmed: 2, failed: 2 };
    for (const message of realtime) {
      const renderKey = key(message);
      const index = persistenceKeys(message).map((alias) => recordAliases.get(alias))
        .find((value) => value !== undefined);
      const existing = index !== undefined ? records[index] : undefined;
      if (!existing) {
        register(message, records.length);
        records.push(message);
        continue;
      }
      const status = (existing.publish_status ? rank[existing.publish_status] : -1) >
        (message.publish_status ? rank[message.publish_status] : -1) ? existing : message;
      const merged = { ...existing, ...message, id: message.id ?? existing.id,
        publish_status: status.publish_status, packet_id: status.packet_id,
        publish_error: status.publish_error, sent_at: status.sent_at, confirmed_at: status.confirmed_at };
      bind(merged, renderKey);
      bind(existing, renderKey);
      register(merged, index!);
      records[index!] = merged;
    }
    // Retain aliases only for loaded records, rather than every arrival forever.
    const retained = new Set(records.flatMap(identityKeys));
    for (const alias of aliases.keys()) if (!retained.has(alias)) aliases.delete(alias);
    return records;
  }

  return { key, merge };
}
