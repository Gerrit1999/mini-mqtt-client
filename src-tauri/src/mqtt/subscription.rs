use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubscriptionOperation {
    Subscribe,
    Unsubscribe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubscriptionRequest {
    Subscribe { requested_qos: u8 },
    Unsubscribe,
}

impl SubscriptionRequest {
    pub fn operation(self) -> SubscriptionOperation {
        match self {
            Self::Subscribe { .. } => SubscriptionOperation::Subscribe,
            Self::Unsubscribe => SubscriptionOperation::Unsubscribe,
        }
    }

    pub fn requested_qos(self) -> Option<u8> {
        match self {
            Self::Subscribe { requested_qos } => Some(requested_qos),
            Self::Unsubscribe => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubscriptionRuntimeStatus {
    Disabled,
    Pending,
    Active,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SubscriptionStateEvent {
    pub server_id: i64,
    pub topic: String,
    pub operation: SubscriptionOperation,
    pub status: SubscriptionRuntimeStatus,
    pub requested_qos: Option<u8>,
    pub granted_qos: Option<u8>,
    pub error: Option<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionOperationResult {
    pub operation_id: String,
    pub granted_qos: Option<u8>,
}

pub(crate) struct StartedSubscriptionOperation {
    pub state: SubscriptionStateEvent,
    pub completion: oneshot::Receiver<Result<SubscriptionOperationResult, String>>,
}

struct PendingSubscriptionOperation {
    operation_id: String,
    server_id: i64,
    topic: String,
    operation: SubscriptionOperation,
    requested_qos: Option<u8>,
    packet_id: Option<u16>,
    completion: oneshot::Sender<Result<SubscriptionOperationResult, String>>,
}

#[derive(Default)]
pub(crate) struct SubscriptionOperationTracker {
    pending: Option<PendingSubscriptionOperation>,
}

impl SubscriptionOperationTracker {
    pub fn start(
        &mut self,
        server_id: i64,
        topic: String,
        request: SubscriptionRequest,
    ) -> Result<StartedSubscriptionOperation, String> {
        if self.pending.is_some() {
            return Err("Another subscription operation is already pending".to_string());
        }

        let operation = request.operation();
        let requested_qos = request.requested_qos();
        let operation_id = uuid::Uuid::new_v4().to_string();
        let (completion, receiver) = oneshot::channel();
        let state = SubscriptionStateEvent {
            server_id,
            topic: topic.clone(),
            operation,
            status: SubscriptionRuntimeStatus::Pending,
            requested_qos,
            granted_qos: None,
            error: None,
            operation_id: operation_id.clone(),
        };

        self.pending = Some(PendingSubscriptionOperation {
            operation_id,
            server_id,
            topic,
            operation,
            requested_qos,
            packet_id: None,
            completion,
        });

        Ok(StartedSubscriptionOperation {
            state,
            completion: receiver,
        })
    }

    pub fn mark_sent(&mut self, operation: SubscriptionOperation, packet_id: u16) -> bool {
        let Some(pending) = self.pending.as_mut() else {
            return false;
        };
        if pending.operation != operation || pending.packet_id.is_some() {
            return false;
        }

        pending.packet_id = Some(packet_id);
        true
    }

    pub fn complete(
        &mut self,
        operation: SubscriptionOperation,
        packet_id: u16,
        granted_qos: Option<u8>,
    ) -> Option<SubscriptionStateEvent> {
        let pending = self.pending.as_ref()?;
        if pending.operation != operation || pending.packet_id != Some(packet_id) {
            return None;
        }

        let pending = self.pending.take()?;
        let status = match operation {
            SubscriptionOperation::Subscribe => SubscriptionRuntimeStatus::Active,
            SubscriptionOperation::Unsubscribe => SubscriptionRuntimeStatus::Disabled,
        };
        let result = SubscriptionOperationResult {
            operation_id: pending.operation_id.clone(),
            granted_qos,
        };
        let state = SubscriptionStateEvent {
            server_id: pending.server_id,
            topic: pending.topic,
            operation,
            status,
            requested_qos: pending.requested_qos,
            granted_qos,
            error: None,
            operation_id: pending.operation_id,
        };

        let _ = pending.completion.send(Ok(result));
        Some(state)
    }

    pub fn fail_current(&mut self, error: String) -> Option<SubscriptionStateEvent> {
        let pending = self.pending.take()?;
        let state = SubscriptionStateEvent {
            server_id: pending.server_id,
            topic: pending.topic,
            operation: pending.operation,
            status: SubscriptionRuntimeStatus::Failed,
            requested_qos: pending.requested_qos,
            granted_qos: None,
            error: Some(error.clone()),
            operation_id: pending.operation_id,
        };

        let _ = pending.completion.send(Err(error));
        Some(state)
    }

    pub fn reject(
        &mut self,
        operation: SubscriptionOperation,
        packet_id: u16,
        error: String,
    ) -> Option<SubscriptionStateEvent> {
        let pending = self.pending.as_ref()?;
        if pending.operation != operation || pending.packet_id != Some(packet_id) {
            return None;
        }

        self.fail_current(error)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SubscriptionOperation, SubscriptionOperationTracker, SubscriptionRequest,
        SubscriptionRuntimeStatus,
    };

    #[tokio::test]
    async fn subscribe_completes_only_after_matching_ack() {
        let mut tracker = SubscriptionOperationTracker::default();
        let mut started = tracker
            .start(
                7,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 2 },
            )
            .unwrap();

        assert_eq!(started.state.status, SubscriptionRuntimeStatus::Pending);
        assert!(started.completion.try_recv().is_err());
        assert!(tracker.mark_sent(SubscriptionOperation::Subscribe, 41));
        assert!(tracker
            .complete(SubscriptionOperation::Subscribe, 42, Some(1))
            .is_none());

        let state = tracker
            .complete(SubscriptionOperation::Subscribe, 41, Some(1))
            .unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(state.status, SubscriptionRuntimeStatus::Active);
        assert_eq!(state.granted_qos, Some(1));
        assert_eq!(result.operation_id, state.operation_id);
        assert_eq!(result.granted_qos, Some(1));
    }

    #[tokio::test]
    async fn failure_releases_pending_operation_and_reports_reason() {
        let mut tracker = SubscriptionOperationTracker::default();
        let started = tracker
            .start(
                7,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 1 },
            )
            .unwrap();

        assert!(tracker
            .start(
                7,
                "other/topic".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 0 },
            )
            .is_err());

        let state = tracker
            .fail_current("Broker rejected subscription".to_string())
            .unwrap();
        let result = started.completion.await.unwrap();

        assert_eq!(state.status, SubscriptionRuntimeStatus::Failed);
        assert_eq!(state.error.as_deref(), Some("Broker rejected subscription"));
        assert_eq!(result.unwrap_err(), "Broker rejected subscription");
        assert!(tracker
            .start(
                7,
                "other/topic".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 0 },
            )
            .is_ok());
    }

    #[tokio::test]
    async fn unsubscribe_completes_as_disabled_only_after_unsuback() {
        let mut tracker = SubscriptionOperationTracker::default();
        let mut started = tracker
            .start(7, "sensor/+".to_string(), SubscriptionRequest::Unsubscribe)
            .unwrap();

        assert!(tracker.mark_sent(SubscriptionOperation::Unsubscribe, 12));
        assert!(started.completion.try_recv().is_err());
        let state = tracker
            .complete(SubscriptionOperation::Unsubscribe, 12, None)
            .unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(state.status, SubscriptionRuntimeStatus::Disabled);
        assert_eq!(result.granted_qos, None);
    }

    #[tokio::test]
    async fn disconnect_before_ack_marks_operation_failed() {
        let mut tracker = SubscriptionOperationTracker::default();
        let started = tracker
            .start(
                7,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 1 },
            )
            .unwrap();
        assert!(tracker.mark_sent(SubscriptionOperation::Subscribe, 8));

        let state = tracker
            .fail_current("Connection closed before acknowledgement".to_string())
            .unwrap();
        let result = started.completion.await.unwrap();

        assert_eq!(state.status, SubscriptionRuntimeStatus::Failed);
        assert_eq!(
            state.error.as_deref(),
            Some("Connection closed before acknowledgement")
        );
        assert_eq!(
            result.unwrap_err(),
            "Connection closed before acknowledgement"
        );
    }

    #[tokio::test]
    async fn timeout_marks_operation_failed_and_allows_retry() {
        let mut tracker = SubscriptionOperationTracker::default();
        let started = tracker
            .start(
                7,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 2 },
            )
            .unwrap();

        let state = tracker
            .fail_current("Subscription acknowledgement timed out".to_string())
            .unwrap();
        let result = started.completion.await.unwrap();

        assert_eq!(state.status, SubscriptionRuntimeStatus::Failed);
        assert_eq!(
            result.unwrap_err(),
            "Subscription acknowledgement timed out"
        );
        assert!(tracker
            .start(
                7,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 2 },
            )
            .is_ok());
    }
}
