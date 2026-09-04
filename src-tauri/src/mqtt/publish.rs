use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishRuntimeStatus {
    Pending,
    Sent,
    Confirmed,
    Failed,
}

impl PublishRuntimeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Confirmed => "confirmed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PublishAckOutcome {
    Success,
    Rejected(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PublishAckPhase {
    PubAck,
    PubRec,
    PubComp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PublishStateEvent {
    pub operation_id: String,
    pub server_id: i64,
    pub qos: u8,
    pub status: PublishRuntimeStatus,
    pub packet_id: Option<u16>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PublishOperationResult {
    pub operation_id: String,
    pub status: PublishRuntimeStatus,
    pub packet_id: Option<u16>,
}

pub(crate) struct StartedPublishOperation {
    pub state: PublishStateEvent,
    pub completion: oneshot::Receiver<Result<PublishOperationResult, String>>,
}

struct PendingPublish {
    state: PublishStateEvent,
    completion: Option<oneshot::Sender<Result<PublishOperationResult, String>>>,
}

#[derive(Default)]
pub(crate) struct PublishOperationTracker {
    awaiting_outgoing: VecDeque<String>,
    operations: HashMap<String, PendingPublish>,
    by_packet_id: HashMap<u16, String>,
}

impl PublishOperationTracker {
    pub fn start(
        &mut self,
        server_id: i64,
        qos: u8,
        operation_id: String,
    ) -> Result<StartedPublishOperation, String> {
        if qos > 2 {
            return Err("Invalid QoS".to_string());
        }
        if operation_id.trim().is_empty() {
            return Err("Publish operation ID is required".to_string());
        }
        if self.operations.contains_key(&operation_id) {
            return Err("Publish operation ID already exists".to_string());
        }

        let (completion, receiver) = oneshot::channel();
        let state = PublishStateEvent {
            operation_id: operation_id.clone(),
            server_id,
            qos,
            status: PublishRuntimeStatus::Pending,
            packet_id: None,
            error: None,
        };
        self.awaiting_outgoing.push_back(operation_id.clone());
        self.operations.insert(
            operation_id,
            PendingPublish {
                state: state.clone(),
                completion: Some(completion),
            },
        );

        Ok(StartedPublishOperation {
            state,
            completion: receiver,
        })
    }

    pub fn on_outgoing_publish(&mut self, packet_id: u16) -> Option<PublishStateEvent> {
        let operation_id = self.awaiting_outgoing.pop_front()?;
        let pending = self.operations.get_mut(&operation_id)?;
        if pending.state.status == PublishRuntimeStatus::Failed {
            self.operations.remove(&operation_id);
            return None;
        }

        pending.state.status = PublishRuntimeStatus::Sent;
        pending.state.packet_id = (packet_id != 0).then_some(packet_id);
        let state = pending.state.clone();

        if pending.state.qos != 0 {
            self.by_packet_id.insert(packet_id, operation_id);
            return Some(state);
        }

        let mut pending = self.operations.remove(&operation_id)?;
        let result = PublishOperationResult {
            operation_id: pending.state.operation_id.clone(),
            status: PublishRuntimeStatus::Sent,
            packet_id: None,
        };
        if let Some(completion) = pending.completion.take() {
            let _ = completion.send(Ok(result));
        }

        Some(state)
    }

    pub fn on_puback(
        &mut self,
        packet_id: u16,
        outcome: PublishAckOutcome,
    ) -> Option<PublishStateEvent> {
        let operation_id = self.by_packet_id.get(&packet_id)?.clone();
        if self.operations.get(&operation_id)?.state.qos != 1 {
            return None;
        }

        self.finish_packet_operation(packet_id, outcome)
    }

    pub fn on_pubrec(
        &mut self,
        packet_id: u16,
        outcome: PublishAckOutcome,
    ) -> Option<PublishStateEvent> {
        let operation_id = self.by_packet_id.get(&packet_id)?.clone();
        if self.operations.get(&operation_id)?.state.qos != 2 {
            return None;
        }

        match outcome {
            PublishAckOutcome::Success => self
                .operations
                .get(&operation_id)
                .map(|pending| pending.state.clone()),
            rejected @ PublishAckOutcome::Rejected(_) => {
                self.finish_packet_operation(packet_id, rejected)
            }
        }
    }

    pub fn on_pubcomp(
        &mut self,
        packet_id: u16,
        outcome: PublishAckOutcome,
    ) -> Option<PublishStateEvent> {
        let operation_id = self.by_packet_id.get(&packet_id)?.clone();
        if self.operations.get(&operation_id)?.state.qos != 2 {
            return None;
        }

        self.finish_packet_operation(packet_id, outcome)
    }

    pub fn fail_operation(
        &mut self,
        operation_id: &str,
        error: String,
    ) -> Option<PublishStateEvent> {
        let pending = self.operations.get_mut(operation_id)?;
        if matches!(
            pending.state.status,
            PublishRuntimeStatus::Confirmed | PublishRuntimeStatus::Failed
        ) {
            return None;
        }

        pending.state.status = PublishRuntimeStatus::Failed;
        pending.state.error = Some(error.clone());
        if let Some(completion) = pending.completion.take() {
            let _ = completion.send(Err(error));
        }
        let packet_id = pending.state.packet_id;
        let state = pending.state.clone();

        if let Some(packet_id) = packet_id {
            self.by_packet_id.remove(&packet_id);
            self.operations.remove(operation_id);
        }

        Some(state)
    }

    pub fn mark_enqueue_failed(
        &mut self,
        operation_id: &str,
        error: String,
    ) -> Option<PublishStateEvent> {
        let is_unsent = self
            .operations
            .get(operation_id)
            .is_some_and(|pending| pending.state.packet_id.is_none());
        if !is_unsent {
            return None;
        }

        self.awaiting_outgoing
            .retain(|queued| queued != operation_id);
        let mut pending = self.operations.remove(operation_id)?;
        pending.state.status = PublishRuntimeStatus::Failed;
        pending.state.error = Some(error.clone());
        if let Some(completion) = pending.completion.take() {
            let _ = completion.send(Err(error));
        }
        Some(pending.state)
    }

    pub fn fail_all(&mut self, error: String) -> Vec<PublishStateEvent> {
        self.awaiting_outgoing.clear();
        self.by_packet_id.clear();

        self.operations
            .drain()
            .map(|(_, mut pending)| {
                pending.state.status = PublishRuntimeStatus::Failed;
                pending.state.error = Some(error.clone());
                if let Some(completion) = pending.completion.take() {
                    let _ = completion.send(Err(error.clone()));
                }
                pending.state
            })
            .collect()
    }

    fn finish_packet_operation(
        &mut self,
        packet_id: u16,
        outcome: PublishAckOutcome,
    ) -> Option<PublishStateEvent> {
        let operation_id = self.by_packet_id.remove(&packet_id)?;
        let mut pending = self.operations.remove(&operation_id)?;
        pending.state.packet_id = Some(packet_id);

        match outcome {
            PublishAckOutcome::Success => {
                pending.state.status = PublishRuntimeStatus::Confirmed;
                let result = PublishOperationResult {
                    operation_id: pending.state.operation_id.clone(),
                    status: PublishRuntimeStatus::Confirmed,
                    packet_id: Some(packet_id),
                };
                if let Some(completion) = pending.completion.take() {
                    let _ = completion.send(Ok(result));
                }
            }
            PublishAckOutcome::Rejected(error) => {
                pending.state.status = PublishRuntimeStatus::Failed;
                pending.state.error = Some(error.clone());
                if let Some(completion) = pending.completion.take() {
                    let _ = completion.send(Err(error));
                }
            }
        }

        Some(pending.state)
    }
}

#[cfg(test)]
mod tests {
    use super::{PublishAckOutcome, PublishOperationTracker, PublishRuntimeStatus};

    #[tokio::test]
    async fn qos0_completes_as_sent_only_after_outgoing_publish() {
        let mut tracker = PublishOperationTracker::default();
        let mut started = tracker.start(7, 0, "op-qos0".to_string()).unwrap();

        assert_eq!(started.state.status, PublishRuntimeStatus::Pending);
        assert!(started.completion.try_recv().is_err());

        let state = tracker.on_outgoing_publish(0).unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(state.status, PublishRuntimeStatus::Sent);
        assert_eq!(state.packet_id, None);
        assert_eq!(result.operation_id, "op-qos0");
        assert_eq!(result.status, PublishRuntimeStatus::Sent);
        assert_eq!(result.packet_id, None);
    }

    #[tokio::test]
    async fn qos1_remains_sent_until_matching_puback() {
        let mut tracker = PublishOperationTracker::default();
        let mut started = tracker.start(7, 1, "op-qos1".to_string()).unwrap();

        let sent = tracker.on_outgoing_publish(41).unwrap();
        assert_eq!(sent.status, PublishRuntimeStatus::Sent);
        assert_eq!(sent.packet_id, Some(41));
        assert!(started.completion.try_recv().is_err());
        assert!(tracker.on_puback(42, PublishAckOutcome::Success).is_none());

        let confirmed = tracker.on_puback(41, PublishAckOutcome::Success).unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(confirmed.status, PublishRuntimeStatus::Confirmed);
        assert_eq!(result.operation_id, "op-qos1");
        assert_eq!(result.status, PublishRuntimeStatus::Confirmed);
        assert_eq!(result.packet_id, Some(41));
    }

    #[tokio::test]
    async fn qos2_confirms_only_after_pubcomp() {
        let mut tracker = PublishOperationTracker::default();
        let mut started = tracker.start(7, 2, "op-qos2".to_string()).unwrap();

        let sent = tracker.on_outgoing_publish(51).unwrap();
        assert_eq!(sent.status, PublishRuntimeStatus::Sent);

        let pubrec = tracker.on_pubrec(51, PublishAckOutcome::Success).unwrap();
        assert_eq!(pubrec.status, PublishRuntimeStatus::Sent);
        assert!(started.completion.try_recv().is_err());

        let confirmed = tracker.on_pubcomp(51, PublishAckOutcome::Success).unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(confirmed.status, PublishRuntimeStatus::Confirmed);
        assert_eq!(result.operation_id, "op-qos2");
        assert_eq!(result.status, PublishRuntimeStatus::Confirmed);
        assert_eq!(result.packet_id, Some(51));
    }

    #[tokio::test]
    async fn timeout_before_outgoing_keeps_fifo_alignment() {
        let mut tracker = PublishOperationTracker::default();
        let first = tracker.start(7, 1, "op-first".to_string()).unwrap();
        let second = tracker.start(7, 1, "op-second".to_string()).unwrap();

        let failed = tracker
            .fail_operation("op-first", "Publish acknowledgement timed out".to_string())
            .unwrap();
        assert_eq!(failed.status, PublishRuntimeStatus::Failed);
        assert_eq!(
            first.completion.await.unwrap().unwrap_err(),
            "Publish acknowledgement timed out"
        );

        assert!(tracker.on_outgoing_publish(61).is_none());
        let sent = tracker.on_outgoing_publish(62).unwrap();
        assert_eq!(sent.operation_id, "op-second");
        assert_eq!(sent.packet_id, Some(62));

        tracker.on_puback(62, PublishAckOutcome::Success).unwrap();
        assert_eq!(
            second.completion.await.unwrap().unwrap().operation_id,
            "op-second"
        );
    }

    #[tokio::test]
    async fn disconnect_fails_all_awaiting_and_sent_operations() {
        let mut tracker = PublishOperationTracker::default();
        let awaiting = tracker.start(7, 1, "op-awaiting".to_string()).unwrap();
        let sent = tracker.start(7, 2, "op-sent".to_string()).unwrap();
        tracker.on_outgoing_publish(71).unwrap();

        let states = tracker.fail_all("Connection closed before acknowledgement".to_string());

        assert_eq!(states.len(), 2);
        assert!(states
            .iter()
            .all(|state| state.status == PublishRuntimeStatus::Failed));
        assert_eq!(
            awaiting.completion.await.unwrap().unwrap_err(),
            "Connection closed before acknowledgement"
        );
        assert_eq!(
            sent.completion.await.unwrap().unwrap_err(),
            "Connection closed before acknowledgement"
        );
        assert!(tracker.on_outgoing_publish(72).is_none());
        assert!(tracker.on_pubcomp(71, PublishAckOutcome::Success).is_none());
    }

    #[tokio::test]
    async fn enqueue_failure_removes_only_the_unsent_operation() {
        let mut tracker = PublishOperationTracker::default();
        let first = tracker.start(7, 1, "op-first".to_string()).unwrap();
        let second = tracker.start(7, 1, "op-second".to_string()).unwrap();

        let failed = tracker
            .mark_enqueue_failed("op-first", "request channel closed".to_string())
            .unwrap();
        assert_eq!(failed.status, PublishRuntimeStatus::Failed);
        assert_eq!(
            first.completion.await.unwrap().unwrap_err(),
            "request channel closed"
        );

        let sent = tracker.on_outgoing_publish(81).unwrap();
        assert_eq!(sent.operation_id, "op-second");
        tracker.on_puback(81, PublishAckOutcome::Success).unwrap();
        assert_eq!(
            second.completion.await.unwrap().unwrap().operation_id,
            "op-second"
        );
    }

    #[tokio::test]
    async fn concurrent_publishes_bind_fifo_and_complete_by_packet_id() {
        let mut tracker = PublishOperationTracker::default();
        let first = tracker.start(7, 1, "op-first".to_string()).unwrap();
        let second = tracker.start(7, 1, "op-second".to_string()).unwrap();

        assert_eq!(
            tracker.on_outgoing_publish(91).unwrap().operation_id,
            "op-first"
        );
        assert_eq!(
            tracker.on_outgoing_publish(92).unwrap().operation_id,
            "op-second"
        );

        tracker.on_puback(92, PublishAckOutcome::Success).unwrap();
        tracker.on_puback(91, PublishAckOutcome::Success).unwrap();
        assert_eq!(first.completion.await.unwrap().unwrap().packet_id, Some(91));
        assert_eq!(
            second.completion.await.unwrap().unwrap().packet_id,
            Some(92)
        );
    }

    #[tokio::test]
    async fn unknown_duplicate_and_wrong_phase_ack_do_not_complete_another_publish() {
        let mut tracker = PublishOperationTracker::default();
        let mut first = tracker.start(7, 1, "op-first".to_string()).unwrap();
        let mut second = tracker.start(7, 2, "op-second".to_string()).unwrap();
        tracker.on_outgoing_publish(101).unwrap();
        tracker.on_outgoing_publish(102).unwrap();

        assert!(tracker.on_puback(999, PublishAckOutcome::Success).is_none());
        assert!(tracker
            .on_pubcomp(101, PublishAckOutcome::Success)
            .is_none());
        assert!(first.completion.try_recv().is_err());
        assert!(second.completion.try_recv().is_err());

        tracker.on_puback(101, PublishAckOutcome::Success).unwrap();
        assert!(tracker.on_puback(101, PublishAckOutcome::Success).is_none());
        assert!(second.completion.try_recv().is_err());

        tracker.on_pubrec(102, PublishAckOutcome::Success).unwrap();
        tracker.on_pubcomp(102, PublishAckOutcome::Success).unwrap();
        assert_eq!(
            first.completion.await.unwrap().unwrap().packet_id,
            Some(101)
        );
        assert_eq!(
            second.completion.await.unwrap().unwrap().packet_id,
            Some(102)
        );
    }

    #[tokio::test]
    async fn qos2_rejection_preserves_broker_reason() {
        let mut tracker = PublishOperationTracker::default();
        let started = tracker.start(7, 2, "op-qos2".to_string()).unwrap();
        tracker.on_outgoing_publish(111).unwrap();

        let state = tracker
            .on_pubrec(
                111,
                PublishAckOutcome::Rejected("NotAuthorized".to_string()),
            )
            .unwrap();

        assert_eq!(state.status, PublishRuntimeStatus::Failed);
        assert_eq!(state.error.as_deref(), Some("NotAuthorized"));
        assert_eq!(
            started.completion.await.unwrap().unwrap_err(),
            "NotAuthorized"
        );
    }
}
