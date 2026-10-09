# Issue #32: batched MQTT receive and bounded pending work

## Contract and ordering

Rust emits `mqtt-message-batch` instead of one `mqtt-message` per receive:

```json
{
  "messages": [{
    "server_id": 1, "topic": "device/data", "payload": [0, 255, 128, 65],
    "qos": 2, "retain": true, "timestamp": "2026-10-09T00:00:00Z", "seq": "123"
  }],
  "dropped_total": 0,
  "emit_failures_total": 0
}
```

`payload` is the original byte vector, without UTF-8 decoding. `seq` is a
manager-wide receive-only u64 serialized as a decimal string, starting at zero.
Every arrival, including an oversized dropped arrival, consumes a sequence. A
single shared batcher assigns sequence and serializes emission under one lock,
so timer/threshold flushes and different servers cannot overtake each other.
Batch transport delivery follows that emission order; this is not a reorder or
retransmission protocol for arbitrary out-of-order/duplicate external events.

The frontend sorts each batch by wire `seq`, then synchronously reserves its
existing shared UI `nextSeq` before any script await. That UI counter still
belongs to receives, `reserveSeq`, `addPublishMessage`, and tracked publishing.
The wire sequence is retained as `receive_seq`; it is never mixed into the UI
counter. Receive order is backend arrival order. Relative publish/receive order
is frontend reservation/event-delivery order, not cross-process wall-clock order.

Live messages sort by UI sequence even when timestamps move backward. SQLite
history has no session sequence: its chronological/id-sorted prefix precedes the
live session. Received history ids are attached to live messages, preserving
history/live id deduplication and existing pagination/export paths.

## Limits and loss scope

| Stage | Limits / trigger | Policy |
| --- | --- | --- |
| Shared Rust receive buffer | 128 messages, 1 MiB payload + UTF-8 topic bytes, or 20 ms | Flush before a new entry would exceed the byte threshold; a single larger entry flushes immediately |
| Rust single entry | 16 MiB payload + topic bytes | Drop oversized arrival before event serialization; sequence gap and cumulative backend drop count |
| Frontend pending work | 2,048 entries and 64 MiB conservative byte charge, globally across servers | Drop newest at admission; do not evict accepted/in-flight entries |
| Frontend processing | One worker; up to 128 entries per processing/history/display flush; initial one-shot 20 ms or 128 entries | Drain serially, including script and persistence awaits |
| History command | At most 128 rows and 64 MiB UTF-8 payload + topic bytes per request | Reject invalid/oversized command; transaction rolls back on failure |
| Existing publish display buffer | 128 entries or 1 MiB payload bytes, otherwise 50 ms | Synchronous flush; no receive worker/publish confirmation changes |

Frontend admission charges `8 * payload.length + 2 * topic.length + 512` bytes
before allocating its `Uint8Array`. This reserves space for protected script
copies, processed bytes, byte-safe hex/UTF-16 history strings and metadata.
Processed expansion requires an additional `8 * max(0, outputBytes - inputBytes)`
reservation before retaining the processed result/history string. Count and byte
reservations remain charged through raw processing, accumulated processed rows,
history IPC in flight, and display merge. Under steady arrivals, a batch already
being processed is included in both hard caps. An individual raw payload near
8 MiB can exhaust the frontend budget by itself, even though MQTT packet-size
settings permit larger packets.

Overflow drops the entire incoming/expanded message from **both live display and
SQLite history**. Accepted messages are persisted after their normal script
processing, with original timestamp and detected byte-safe format. A failed
script still logs one silent occurrence with its cause/id/context and preserves
original bytes; script/env cache-load failures retain their tolerant behavior.
Only successful intentional scripts convert text output back to bytes.

A persistence error keeps live display but loses that batch's history write;
there is no unbounded retry queue. A non-script processing exception skips the
affected entry and increments failures. An unexpected flush exception releases
its reservations and later queued batches continue. Failed Rust emits drop the
attempted batch and increment cumulative drops and emit failures; the next
successful emission reports those counters. The first emit failure also writes
an immediate native `LogManager` error diagnostic, including the original emit
cause (capped at 1,024 characters with a truncation marker), the lost batch count,
cumulative drops and cumulative emit failures. If `LogManager` is unavailable or
its write fails, stderr receives the same diagnostic and the fallback reason.
Native receive diagnostics are throttled to at most one per five seconds per
shared batcher; a later eligible failure includes the latest cumulative totals.
Suppressed failures are not queued for idle reporting. If traffic stops after an
emit failure, no idle diagnostic/retry timer is started.

`mqttStore.receiveStats` exposes pending/peak count and charged bytes, accepted,
frontend dropped, processing/persistence failure occurrences, backend dropped,
and emit-failure totals. `getReceivedCount(server)` counts delivered arrivals
including frontend drops, not messages dropped before IPC. Overflow and failure
notifications share a five-second throttle; failure console diagnostics use the
same throttle. Script logging retains Issue #30's separate aggregation behavior.

Both timers are one-shot. Threshold flushes cancel their pending timer; Rust
also checks timer generations against cancellation races. Constructors start no
Tokio task: the receive timer is created lazily from the existing event loop's
runtime. Idle buffers do not periodically wake.

These are caps on application-owned pending reservations, not a measurement or
limit on all process RSS. Tauri/WebView transport buffering, retained visible
messages, temporary codec allocations, arbitrary user-script allocations and
the MQTT library's own packet buffers are outside this queue budget. MQTT
acknowledgements, packet-size configuration, protocol handshakes, reconnection,
DB schema/migrations and tracked publish confirmations are unchanged.

## Reproducible benchmark

From the repository root, after `npm ci`:

```sh
node scripts/benchmark-receive.mjs
```

The ignored Rust test drives the production shared batcher and real serde event
serialization with simulated broker arrivals: 8,192 messages of 256 binary bytes,
interleaved across three servers. Sustained input sends 64 arrivals then sleeps
4 ms; burst input sends all arrivals without awaiting. The captured Rust events
are replayed against both the actual original store from
`28fb7fa6b9afba84a0f7ae205fe8969511488e4b` and the changed production store.
The original store is temporarily copied and instrumented only to observe
pending entries until both display and persistence finish. The harness removes
its generated baseline file and fixture afterward.

Tauri listeners, history IPC and SQLite are **mocked** in the frontend benchmark;
each history invocation awaits a simulated 2 ms latency. Byte peaks use the same
conservative charge formula before/after. Durations include offered arrival pace,
processing, mock history latency and final display drain; they are elapsed time,
not CPU time. Rust timings include fixture serialization/collection and final
timer drain. Rust buffer metrics sample residual pending entries after push (127
entries / 33,274 bytes in this run; threshold emission itself contains 128 entries).
This does not establish Windows/WebView throughput or SQLite disk performance.

Parent verification in the Linux development container, 2026-10-09:

| Workload | Version | Emit IPC | History IPC | Total IPC | Persisted / dropped | Elapsed ms | Peak pending count | Peak charged bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sustained | Before | 8,192 | 8,192 | 16,384 | 8,192 / 0 | 770.76 | 640 | 1,646,080 |
| Sustained | After | 64 | 64 | 128 | 8,192 / 0 | 758.83 | 128 | 329,216 |
| Burst | Before | 8,192 | 8,192 | 16,384 | 8,192 / 0 | 264.53 | 8,192 | 21,069,824 |
| Burst | After | 64 | 16 | 80 | 2,048 / 6,144 | 92.03 | 2,048 | 5,267,456 |

Sustained total IPC fell 99.22% with no drops; elapsed time is dominated by input
pace. Burst after duration is shorter partly because 6,144 messages are explicitly
dropped; it is not an equal-retention speedup claim. Rust fixture generation took
864 ms sustained / 139 ms burst. Counts are reproducible for these workloads;
timings and sustained pending peaks vary with host scheduling.

The before burst reaches 8,192 pending entries, violating the new 2,048-entry
invariant. After stays at 2,048 including in-flight persistence. This is observed
on the original production store, not a count reduction computed from thresholds.

## Focused verification

Changed files are limited to:

- Rust receive integration: `src-tauri/src/mqtt/client.rs`, `mqtt/mod.rs`, new `mqtt/receive.rs`.
- Batched history persistence: `src-tauri/src/commands/publish.rs`, `db/mod.rs`, `lib.rs`.
- Frontend receive path: `src/stores/mqtt.ts`, `src/types/mqtt.ts`, new `src/utils/receiveQueue.ts`.
- Live ordering: `src/components/mqtt/MessageList.vue`.
- Targeted regressions: `src/stores/mqtt.test.ts`, `src/utils/scriptErrorRouting.test.ts`, `src/components/mqtt/MessageList.test.ts`, new `src/utils/receiveQueue.test.ts`.
- Runtime overflow/failure text: `src/i18n/locales/en-US.yaml`, `zh-CN.yaml`.
- Benchmark and documentation: new `scripts/benchmark-receive.mjs`, `src/stores/receiveBenchmark.test.ts`, this document.

```sh
npx vitest run src/stores/mqtt.test.ts src/utils/receiveQueue.test.ts src/utils/scriptErrorRouting.test.ts src/components/mqtt/MessageList.test.ts src/components/mqtt/PublishPanel.test.ts src/utils/payloadCodec.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --locked mqtt:: --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked db::tests --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked commands::publish --lib
npm run build
rustfmt --edition 2021 --config skip_children=true --check src-tauri/src/mqtt/receive.rs src-tauri/src/mqtt/client.rs src-tauri/src/mqtt/mod.rs src-tauri/src/commands/publish.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
```

Regressions cover shared multi-server order, slow script awaits, single protected
binary payload copies, script/cache/environment failures, invalid UTF-8/NUL,
item/byte overflow including in-flight entries, expansion reservation rejection,
thrown consumer/display flush recovery, persistence failure recovery, timer
threshold/time/rearm/idle lifecycle, real MQTT 3.1.1/5 receive event-loop emission,
real serialization, immediate native emit-failure diagnostics without later
arrivals, no idle failure rearming, bounded/throttled diagnostics, native log write
and stderr fallback, ordered recovery with cumulative counters, batch-command
SQLite writes, timestamp/format/id preservation,
pagination, transaction rollback and retained tracked publish behavior.

Parent final validation passed:

- `npm test`: 240 tests across 28 files; the opt-in benchmark was skipped.
- `cargo test --locked`: 76 tests; the opt-in fixture was ignored.
- `npm run build`: type checking and production build passed, with the existing
  chunk-size warning.
- `node scripts/benchmark-receive.mjs`: the Rust fixture and frontend benchmark
  both passed and produced the results above.
- Changed-file Rust formatting checks passed.
- Independent Standards and Spec reviews completed; the missing immediate native
  diagnostic for failed emits was fixed and its regressions passed.

No Windows/WebView smoke test or real SQLite throughput measurement was run.
