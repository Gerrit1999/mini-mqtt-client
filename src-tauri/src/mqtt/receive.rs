use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

pub const BATCH_COUNT: usize = 128;
pub const BATCH_BYTES: usize = 1024 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
pub const BATCH_WINDOW: Duration = Duration::from_millis(20);
const DIAGNOSTIC_INTERVAL: Duration = Duration::from_secs(5);
const MAX_CAUSE_CHARS: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceivedMessage {
    pub server_id: i64,
    pub topic: String,
    pub payload: Vec<u8>,
    pub qos: u8,
    pub retain: bool,
    pub timestamp: String,
    // Decimal string keeps the full u64 precision in JavaScript. Receive-only order.
    pub seq: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiveBatch {
    pub messages: Vec<ReceivedMessage>,
    pub dropped_total: u64,
    pub emit_failures_total: u64,
}

type Emit = Box<dyn Fn(&ReceiveBatch) -> Result<(), String> + Send + Sync>;
type Diagnostic = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct State {
    messages: Vec<ReceivedMessage>,
    bytes: usize,
    next_seq: u64,
    dropped_total: u64,
    emit_failures_total: u64,
    last_diagnostic: Option<Instant>,
    timer: Option<JoinHandle<()>>,
    timer_generation: u64,
}

// One shared ordering seam for every server. Emission stays under the lock so a
// threshold flush cannot overtake a timer flush. No task is started at construction.
pub struct ReceiveBatcher {
    state: Mutex<State>,
    emit: Emit,
    diagnostic: Diagnostic,
}

impl ReceiveBatcher {
    pub fn new(
        emit: impl Fn(&ReceiveBatch) -> Result<(), String> + Send + Sync + 'static,
        diagnostic: impl Fn(&str) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            emit: Box::new(emit),
            diagnostic: Box::new(diagnostic),
        })
    }

    pub fn push(self: &Arc<Self>, mut message: ReceivedMessage) {
        let mut state = self.state.lock();
        message.seq = state.next_seq.to_string();
        state.next_seq += 1;
        let bytes = message.payload.len() + message.topic.len();
        if bytes > MAX_MESSAGE_BYTES {
            state.dropped_total += 1;
        } else {
            if !state.messages.is_empty() && state.bytes + bytes > BATCH_BYTES {
                self.flush_locked(&mut state);
            }
            state.bytes += bytes;
            state.messages.push(message);
            if state.messages.len() >= BATCH_COUNT || state.bytes >= BATCH_BYTES {
                self.flush_locked(&mut state);
                return;
            }
        }
        if state.timer.is_none() {
            state.timer_generation += 1;
            let generation = state.timer_generation;
            let batcher = self.clone();
            state.timer = Some(tokio::spawn(async move {
                tokio::time::sleep(BATCH_WINDOW).await;
                let mut state = batcher.state.lock();
                if state.timer_generation != generation {
                    return;
                }
                // The one-shot has finished; don't abort our own task.
                state.timer.take();
                batcher.flush_locked(&mut state);
            }));
        }
    }

    fn flush_locked(&self, state: &mut State) {
        state.timer_generation += 1;
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        let batch = ReceiveBatch {
            messages: std::mem::take(&mut state.messages),
            dropped_total: state.dropped_total,
            emit_failures_total: state.emit_failures_total,
        };
        state.bytes = 0;
        if let Err(cause) = (self.emit)(&batch) {
            state.dropped_total += batch.messages.len() as u64;
            state.emit_failures_total += 1;
            let now = Instant::now();
            if state
                .last_diagnostic
                .map_or(true, |last| now.duration_since(last) >= DIAGNOSTIC_INTERVAL)
            {
                state.last_diagnostic = Some(now);
                // Bound both frequency and cause size; never queue a diagnostic
                // or start an idle task for failures suppressed by the throttle.
                let mut bounded_cause: String = cause.chars().take(MAX_CAUSE_CHARS).collect();
                if bounded_cause.len() < cause.len() {
                    bounded_cause.push_str("… [truncated]");
                }
                (self.diagnostic)(&format!(
                    "lost_batch_count={}, dropped_total={}, emit_failures_total={}, cause={bounded_cause}",
                    batch.messages.len(), state.dropped_total, state.emit_failures_total
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn message(server_id: i64, payload: Vec<u8>) -> ReceivedMessage {
        ReceivedMessage {
            server_id,
            topic: "binary".into(),
            payload,
            qos: 2,
            retain: true,
            timestamp: "2026-10-09T00:00:00Z".into(),
            seq: String::new(),
        }
    }

    #[test]
    fn construction_needs_no_runtime() {
        let batcher = ReceiveBatcher::new(|_| Ok(()), |_| {});
        assert!(batcher.state.lock().timer.is_none());
    }

    #[tokio::test]
    async fn threshold_time_idle_and_interleaved_binary_contract() {
        let batches = Arc::new(Mutex::new(Vec::new()));
        let collected = batches.clone();
        let batcher = ReceiveBatcher::new(
            move |batch| {
                collected.lock().push(batch.clone());
                Ok(())
            },
            |_| {},
        );
        let binary = vec![0, 255, 128, 65];
        for index in 0..BATCH_COUNT {
            batcher.push(message((index % 2) as i64, binary.clone()));
        }
        assert_eq!(batches.lock().len(), 1);
        assert!(batcher.state.lock().timer.is_none());
        batcher.push(message(2, binary.clone()));
        assert!(batcher.state.lock().timer.is_some());
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        assert_eq!(batches.lock().len(), 2);
        assert!(batcher.state.lock().timer.is_none());
        tokio::time::sleep(BATCH_WINDOW * 2).await;
        assert_eq!(batches.lock().len(), 2, "idle must not emit or rearm");
        let batches = batches.lock();
        let messages: Vec<_> = batches.iter().flat_map(|batch| &batch.messages).collect();
        for (index, message) in messages.iter().enumerate() {
            assert_eq!(message.seq, index.to_string());
            assert_eq!(message.payload, binary);
        }
        let json = serde_json::to_value(&batches[0]).unwrap();
        assert_eq!(
            json["messages"][0],
            serde_json::json!({
                "server_id": 0, "topic": "binary", "payload": [0,255,128,65],
                "qos": 2, "retain": true, "timestamp": "2026-10-09T00:00:00Z", "seq": "0"
            })
        );
    }

    #[tokio::test]
    async fn byte_threshold_overflow_and_failed_emit_recover() {
        let fail = Arc::new(AtomicBool::new(true));
        let failing = fail.clone();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let collected = batches.clone();
        let batcher = ReceiveBatcher::new(
            move |batch| {
                if failing.swap(false, Ordering::SeqCst) {
                    return Err("transient".into());
                }
                collected.lock().push(batch.clone());
                Ok(())
            },
            |_| {},
        );
        batcher.push(message(1, vec![0; BATCH_BYTES]));
        assert!(batcher.state.lock().timer.is_none());
        batcher.push(message(2, vec![0; MAX_MESSAGE_BYTES + 1]));
        batcher.push(message(1, vec![0, 255]));
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        let batches = batches.lock();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].dropped_total, 2);
        assert_eq!(batches[0].emit_failures_total, 1);
        assert_eq!(batches[0].messages[0].seq, "2");
        assert_eq!(batcher.state.lock().bytes, 0);
    }

    #[tokio::test]
    async fn failed_timer_emit_reports_without_later_arrivals_or_idle_rearming() {
        let attempts = Arc::new(Mutex::new(0));
        let emitted = attempts.clone();
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let reported = diagnostics.clone();
        let batcher = ReceiveBatcher::new(
            move |_| {
                *emitted.lock() += 1;
                Err("webview transport closed".into())
            },
            move |details| reported.lock().push(details.to_string()),
        );
        batcher.push(message(1, vec![0, 255]));
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        assert_eq!(*attempts.lock(), 1);
        assert_eq!(diagnostics.lock().as_slice(), &[
            "lost_batch_count=1, dropped_total=1, emit_failures_total=1, cause=webview transport closed"
        ]);
        {
            let state = batcher.state.lock();
            assert!(state.timer.is_none());
            assert!(state.messages.is_empty());
            assert_eq!(state.bytes, 0);
            assert_eq!(state.dropped_total, 1);
            assert_eq!(state.emit_failures_total, 1);
        }
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        assert_eq!(*attempts.lock(), 1, "no idle emit retry");
        assert_eq!(diagnostics.lock().len(), 1, "no idle diagnostic retry");
        assert!(batcher.state.lock().timer.is_none());
    }

    #[tokio::test]
    async fn failure_diagnostics_are_bounded_throttled_and_recovery_keeps_order() {
        let fail = Arc::new(AtomicBool::new(true));
        let failing = fail.clone();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let collected = batches.clone();
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let reported = diagnostics.clone();
        let batcher = ReceiveBatcher::new(
            move |batch| {
                if failing.load(Ordering::SeqCst) {
                    return Err(format!(
                        "original cause: {}",
                        "界".repeat(MAX_CAUSE_CHARS * 2)
                    ));
                }
                collected.lock().push(batch.clone());
                Ok(())
            },
            move |details| reported.lock().push(details.to_string()),
        );
        // Count-triggered failures report synchronously, then stay throttled.
        for _ in 0..BATCH_COUNT * 3 {
            batcher.push(message(1, vec![0]));
        }
        assert_eq!(diagnostics.lock().len(), 1);
        let first = diagnostics.lock()[0].clone();
        assert!(first.contains("lost_batch_count=128, dropped_total=128, emit_failures_total=1"));
        assert!(first.contains("cause=original cause: "));
        assert!(first.ends_with("… [truncated]"));
        assert!(first.len() < MAX_CAUSE_CHARS * 4 + 200);
        assert!(batcher.state.lock().timer.is_none());

        // Age the timestamp instead of sleeping or adding a clock abstraction.
        batcher.state.lock().last_diagnostic = Some(Instant::now() - DIAGNOSTIC_INTERVAL);
        for _ in 0..BATCH_COUNT {
            batcher.push(message(2, vec![255]));
        }
        assert_eq!(diagnostics.lock().len(), 2);
        assert!(diagnostics.lock()[1].contains("dropped_total=512, emit_failures_total=4"));
        fail.store(false, Ordering::SeqCst);
        batcher.push(message(1, vec![0, 255]));
        batcher.push(message(2, vec![128]));
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        let batches = batches.lock();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].dropped_total, 512);
        assert_eq!(batches[0].emit_failures_total, 4);
        assert_eq!(batches[0].messages[0].seq, "512");
        assert_eq!(batches[0].messages[1].seq, "513");
        assert_eq!(batches[0].messages[0].payload, vec![0, 255]);
        assert_eq!(batches[0].messages[1].payload, vec![128]);
        assert_eq!(diagnostics.lock().len(), 2);
        assert!(batcher.state.lock().timer.is_none());
    }

    // Captures the real batcher/serializer, with simulated broker arrivals. The
    // frontend harness replays this fixture against both production stores.
    #[tokio::test]
    #[ignore = "run with scripts/benchmark-receive.mjs"]
    async fn receive_benchmark_fixture() {
        let mut workloads = Vec::new();
        for workload in ["sustained", "burst"] {
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let output = emitted.clone();
            let start = std::time::Instant::now();
            let batcher = ReceiveBatcher::new(
                move |batch| {
                    output.lock().push(serde_json::json!({
                        "at_ms": start.elapsed().as_millis(), "batch": batch
                    }));
                    Ok(())
                },
                |_| {},
            );
            let mut peak_count = 0;
            let mut peak_bytes = 0;
            for index in 0..8192 {
                batcher.push(message(
                    (index % 3) as i64 + 1,
                    (0..256).map(|byte| byte as u8).collect(),
                ));
                let state = batcher.state.lock();
                peak_count = peak_count.max(state.messages.len());
                peak_bytes = peak_bytes.max(state.bytes);
                drop(state);
                if workload == "sustained" && index % 64 == 63 {
                    tokio::time::sleep(Duration::from_millis(4)).await;
                }
            }
            tokio::time::sleep(BATCH_WINDOW * 2).await;
            let events = emitted.lock().clone();
            workloads.push(serde_json::json!({
                "workload": workload, "received": 8192, "dropped": 0,
                "emit_ipc": events.len(), "duration_ms": start.elapsed().as_millis(),
                "peak_pending_count": peak_count, "peak_pending_payload_bytes": peak_bytes,
                "events": events
            }));
        }
        std::fs::write(
            std::env::var("ISSUE32_BENCH_FIXTURE").unwrap(),
            serde_json::to_vec(&workloads).unwrap(),
        )
        .unwrap();
    }
}
