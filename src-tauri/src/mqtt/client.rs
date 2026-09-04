use parking_lot::RwLock;
use rumqttc::v5::{
    AsyncClient as V5AsyncClient, Event as V5Event, EventLoop as V5EventLoop,
    MqttOptions as V5MqttOptions,
};
use rumqttc::{
    AsyncClient as V3AsyncClient, Event as V3Event, EventLoop as V3EventLoop,
    MqttOptions as V3MqttOptions, Packet as V3Packet, QoS as V3QoS, Transport,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio::time::timeout;

use crate::db::{models::MqttServer, Storage};
use crate::log::{LogEntry, LogManager};
use crate::mqtt::publish::{
    PublishAckOutcome, PublishAckPhase, PublishOperationResult, PublishOperationTracker,
    PublishStateEvent, StartedPublishOperation,
};
use crate::mqtt::subscription::{
    StartedSubscriptionOperation, SubscriptionOperation, SubscriptionOperationResult,
    SubscriptionOperationTracker, SubscriptionRequest, SubscriptionStateEvent,
};

const SUBSCRIPTION_ACK_TIMEOUT: Duration = Duration::from_secs(10);
const PUBLISH_ACK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MqttProtocolVersion {
    #[serde(rename = "3.1.1")]
    V3_1_1,
    #[serde(rename = "5.0")]
    V5_0,
}

impl MqttProtocolVersion {
    pub fn supports(self, capability: MqttCapability) -> bool {
        match capability {
            MqttCapability::PublishProperties
            | MqttCapability::SessionExpiry
            | MqttCapability::TopicAlias => self == Self::V5_0,
        }
    }

    fn capabilities(self) -> Vec<MqttCapability> {
        [
            MqttCapability::PublishProperties,
            MqttCapability::SessionExpiry,
            MqttCapability::TopicAlias,
        ]
        .into_iter()
        .filter(|capability| self.supports(*capability))
        .collect()
    }
}

impl TryFrom<&str> for MqttProtocolVersion {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "3.1.1" => Ok(Self::V3_1_1),
            "5.0" => Ok(Self::V5_0),
            _ => Err(format!(
                "Unsupported MQTT protocol version: {}. Supported versions: 3.1.1, 5.0",
                value
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MqttCapability {
    PublishProperties,
    SessionExpiry,
    TopicAlias,
}

#[derive(Debug)]
struct NoCertificateVerification(Arc<rumqttc::tokio_rustls::rustls::crypto::CryptoProvider>);

impl NoCertificateVerification {
    fn new() -> Arc<Self> {
        Arc::new(Self(Arc::new(
            rumqttc::tokio_rustls::rustls::crypto::ring::default_provider(),
        )))
    }
}

impl rumqttc::tokio_rustls::rustls::client::danger::ServerCertVerifier
    for NoCertificateVerification
{
    fn verify_server_cert(
        &self,
        _end_entity: &rumqttc::tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rumqttc::tokio_rustls::rustls::pki_types::CertificateDer<'_>],
        _server_name: &rumqttc::tokio_rustls::rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rumqttc::tokio_rustls::rustls::pki_types::UnixTime,
    ) -> Result<
        rumqttc::tokio_rustls::rustls::client::danger::ServerCertVerified,
        rumqttc::tokio_rustls::rustls::Error,
    > {
        Ok(rumqttc::tokio_rustls::rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rumqttc::tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &rumqttc::tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<
        rumqttc::tokio_rustls::rustls::client::danger::HandshakeSignatureValid,
        rumqttc::tokio_rustls::rustls::Error,
    > {
        rumqttc::tokio_rustls::rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rumqttc::tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &rumqttc::tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<
        rumqttc::tokio_rustls::rustls::client::danger::HandshakeSignatureValid,
        rumqttc::tokio_rustls::rustls::Error,
    > {
        rumqttc::tokio_rustls::rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rumqttc::tokio_rustls::rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionState {
    pub server_id: i64,
    pub status: String, // "disconnected", "connecting", "connected", "error"
    pub error: Option<String>,
    pub protocol_version: Option<MqttProtocolVersion>,
    pub capabilities: Vec<MqttCapability>,
}

impl ConnectionState {
    fn new(
        server_id: i64,
        status: &str,
        error: Option<String>,
        protocol_version: Option<MqttProtocolVersion>,
    ) -> Self {
        let capabilities = protocol_version
            .map(MqttProtocolVersion::capabilities)
            .unwrap_or_default();
        Self {
            server_id,
            status: status.to_string(),
            error,
            protocol_version,
            capabilities,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceivedMessage {
    pub server_id: i64,
    pub topic: String,
    pub payload: Vec<u8>,
    pub qos: u8,
    pub retain: bool,
    pub timestamp: String,
}

#[derive(Clone)]
enum ProtocolClient {
    V3_1_1(V3AsyncClient),
    V5_0(V5AsyncClient),
}

impl ProtocolClient {
    async fn publish(
        &self,
        topic: String,
        qos: u8,
        retain: bool,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        match self {
            Self::V3_1_1(client) => client
                .publish(topic, Self::v3_qos(qos)?, retain, payload)
                .await
                .map_err(|e| e.to_string()),
            Self::V5_0(client) => client
                .publish(topic, Self::v5_qos(qos)?, retain, payload)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    async fn subscribe(&self, topic: String, qos: u8) -> Result<(), String> {
        match self {
            Self::V3_1_1(client) => client
                .subscribe(topic, Self::v3_qos(qos)?)
                .await
                .map_err(|e| e.to_string()),
            Self::V5_0(client) => client
                .subscribe(topic, Self::v5_qos(qos)?)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    async fn unsubscribe(&self, topic: String) -> Result<(), String> {
        match self {
            Self::V3_1_1(client) => client.unsubscribe(topic).await.map_err(|e| e.to_string()),
            Self::V5_0(client) => client.unsubscribe(topic).await.map_err(|e| e.to_string()),
        }
    }

    fn v3_qos(qos: u8) -> Result<V3QoS, String> {
        match qos {
            0 => Ok(V3QoS::AtMostOnce),
            1 => Ok(V3QoS::AtLeastOnce),
            2 => Ok(V3QoS::ExactlyOnce),
            _ => Err("Invalid QoS".to_string()),
        }
    }

    fn v5_qos(qos: u8) -> Result<rumqttc::v5::mqttbytes::QoS, String> {
        use rumqttc::v5::mqttbytes::QoS;

        match qos {
            0 => Ok(QoS::AtMostOnce),
            1 => Ok(QoS::AtLeastOnce),
            2 => Ok(QoS::ExactlyOnce),
            _ => Err("Invalid QoS".to_string()),
        }
    }
}

enum ProtocolEventLoop {
    V3_1_1(Box<V3EventLoop>),
    V5_0(Box<V5EventLoop>),
}

enum ProtocolEvent {
    Connected,
    ConnectionRefused(String),
    Publish {
        topic: String,
        payload: Vec<u8>,
        qos: u8,
        retain: bool,
    },
    PublishRequestSent {
        packet_id: u16,
    },
    PublishAcknowledged {
        phase: PublishAckPhase,
        packet_id: u16,
        outcome: PublishAckOutcome,
    },
    SubscriptionRequestSent {
        operation: SubscriptionOperation,
        packet_id: u16,
    },
    SubscriptionAcknowledged {
        operation: SubscriptionOperation,
        packet_id: u16,
        granted_qos: Option<u8>,
    },
    SubscriptionRejected {
        operation: SubscriptionOperation,
        packet_id: u16,
        error: String,
    },
    Other,
}

impl ProtocolEventLoop {
    fn map_v3_event(event: V3Event) -> Result<ProtocolEvent, String> {
        match event {
            V3Event::Incoming(V3Packet::ConnAck(ack)) => {
                if ack.code == rumqttc::ConnectReturnCode::Success {
                    Ok(ProtocolEvent::Connected)
                } else {
                    Ok(ProtocolEvent::ConnectionRefused(format!("{:?}", ack.code)))
                }
            }
            V3Event::Incoming(V3Packet::Publish(publish)) => Ok(ProtocolEvent::Publish {
                topic: publish.topic,
                payload: publish.payload.to_vec(),
                qos: publish.qos as u8,
                retain: publish.retain,
            }),
            V3Event::Outgoing(rumqttc::Outgoing::Publish(packet_id)) => {
                Ok(ProtocolEvent::PublishRequestSent { packet_id })
            }
            V3Event::Incoming(V3Packet::PubAck(ack)) => Ok(ProtocolEvent::PublishAcknowledged {
                phase: PublishAckPhase::PubAck,
                packet_id: ack.pkid,
                outcome: PublishAckOutcome::Success,
            }),
            V3Event::Incoming(V3Packet::PubRec(ack)) => Ok(ProtocolEvent::PublishAcknowledged {
                phase: PublishAckPhase::PubRec,
                packet_id: ack.pkid,
                outcome: PublishAckOutcome::Success,
            }),
            V3Event::Incoming(V3Packet::PubComp(ack)) => Ok(ProtocolEvent::PublishAcknowledged {
                phase: PublishAckPhase::PubComp,
                packet_id: ack.pkid,
                outcome: PublishAckOutcome::Success,
            }),
            V3Event::Outgoing(rumqttc::Outgoing::Subscribe(packet_id)) => {
                Ok(ProtocolEvent::SubscriptionRequestSent {
                    operation: SubscriptionOperation::Subscribe,
                    packet_id,
                })
            }
            V3Event::Outgoing(rumqttc::Outgoing::Unsubscribe(packet_id)) => {
                Ok(ProtocolEvent::SubscriptionRequestSent {
                    operation: SubscriptionOperation::Unsubscribe,
                    packet_id,
                })
            }
            V3Event::Incoming(V3Packet::SubAck(ack)) => match ack.return_codes.as_slice() {
                [rumqttc::SubscribeReasonCode::Success(qos)] => {
                    Ok(ProtocolEvent::SubscriptionAcknowledged {
                        operation: SubscriptionOperation::Subscribe,
                        packet_id: ack.pkid,
                        granted_qos: Some(*qos as u8),
                    })
                }
                [rumqttc::SubscribeReasonCode::Failure] => {
                    Ok(ProtocolEvent::SubscriptionRejected {
                        operation: SubscriptionOperation::Subscribe,
                        packet_id: ack.pkid,
                        error: "Broker rejected subscription".to_string(),
                    })
                }
                return_codes => Ok(ProtocolEvent::SubscriptionRejected {
                    operation: SubscriptionOperation::Subscribe,
                    packet_id: ack.pkid,
                    error: format!("Unexpected SUBACK return codes: {return_codes:?}"),
                }),
            },
            V3Event::Incoming(V3Packet::UnsubAck(ack)) => {
                Ok(ProtocolEvent::SubscriptionAcknowledged {
                    operation: SubscriptionOperation::Unsubscribe,
                    packet_id: ack.pkid,
                    granted_qos: None,
                })
            }
            _ => Ok(ProtocolEvent::Other),
        }
    }

    fn map_v5_event(event: V5Event) -> Result<ProtocolEvent, String> {
        use rumqttc::v5::mqttbytes::v5::{
            Packet, PubAckReason, PubCompReason, PubRecReason, SubscribeReasonCode, UnsubAckReason,
        };

        match event {
            V5Event::Incoming(Packet::ConnAck(ack)) => {
                if ack.code == rumqttc::v5::mqttbytes::v5::ConnectReturnCode::Success {
                    Ok(ProtocolEvent::Connected)
                } else {
                    Ok(ProtocolEvent::ConnectionRefused(format!("{:?}", ack.code)))
                }
            }
            V5Event::Incoming(Packet::Publish(publish)) => {
                let topic = String::from_utf8(publish.topic.to_vec())
                    .map_err(|error| format!("Invalid MQTT 5.0 topic: {error}"))?;
                Ok(ProtocolEvent::Publish {
                    topic,
                    payload: publish.payload.to_vec(),
                    qos: publish.qos as u8,
                    retain: publish.retain,
                })
            }
            V5Event::Outgoing(rumqttc::Outgoing::Publish(packet_id)) => {
                Ok(ProtocolEvent::PublishRequestSent { packet_id })
            }
            V5Event::Incoming(Packet::PubAck(ack)) => {
                let outcome = match ack.reason {
                    PubAckReason::Success | PubAckReason::NoMatchingSubscribers => {
                        PublishAckOutcome::Success
                    }
                    reason => PublishAckOutcome::Rejected(format!(
                        "Broker rejected QoS 1 publish: {reason:?}"
                    )),
                };
                Ok(ProtocolEvent::PublishAcknowledged {
                    phase: PublishAckPhase::PubAck,
                    packet_id: ack.pkid,
                    outcome,
                })
            }
            V5Event::Incoming(Packet::PubRec(ack)) => {
                let outcome = match ack.reason {
                    PubRecReason::Success | PubRecReason::NoMatchingSubscribers => {
                        PublishAckOutcome::Success
                    }
                    reason => PublishAckOutcome::Rejected(format!(
                        "Broker rejected QoS 2 publish: {reason:?}"
                    )),
                };
                Ok(ProtocolEvent::PublishAcknowledged {
                    phase: PublishAckPhase::PubRec,
                    packet_id: ack.pkid,
                    outcome,
                })
            }
            V5Event::Incoming(Packet::PubComp(ack)) => {
                let outcome = match ack.reason {
                    PubCompReason::Success => PublishAckOutcome::Success,
                    reason => PublishAckOutcome::Rejected(format!(
                        "Broker failed to complete QoS 2 publish: {reason:?}"
                    )),
                };
                Ok(ProtocolEvent::PublishAcknowledged {
                    phase: PublishAckPhase::PubComp,
                    packet_id: ack.pkid,
                    outcome,
                })
            }
            V5Event::Outgoing(rumqttc::Outgoing::Subscribe(packet_id)) => {
                Ok(ProtocolEvent::SubscriptionRequestSent {
                    operation: SubscriptionOperation::Subscribe,
                    packet_id,
                })
            }
            V5Event::Outgoing(rumqttc::Outgoing::Unsubscribe(packet_id)) => {
                Ok(ProtocolEvent::SubscriptionRequestSent {
                    operation: SubscriptionOperation::Unsubscribe,
                    packet_id,
                })
            }
            V5Event::Incoming(Packet::SubAck(ack)) => match ack.return_codes.as_slice() {
                [SubscribeReasonCode::Success(qos)] => {
                    Ok(ProtocolEvent::SubscriptionAcknowledged {
                        operation: SubscriptionOperation::Subscribe,
                        packet_id: ack.pkid,
                        granted_qos: Some(*qos as u8),
                    })
                }
                return_codes => Ok(ProtocolEvent::SubscriptionRejected {
                    operation: SubscriptionOperation::Subscribe,
                    packet_id: ack.pkid,
                    error: format!("Broker rejected subscription: {return_codes:?}"),
                }),
            },
            V5Event::Incoming(Packet::UnsubAck(ack)) => match ack.reasons.as_slice() {
                [UnsubAckReason::Success | UnsubAckReason::NoSubscriptionExisted] => {
                    Ok(ProtocolEvent::SubscriptionAcknowledged {
                        operation: SubscriptionOperation::Unsubscribe,
                        packet_id: ack.pkid,
                        granted_qos: None,
                    })
                }
                reasons => Ok(ProtocolEvent::SubscriptionRejected {
                    operation: SubscriptionOperation::Unsubscribe,
                    packet_id: ack.pkid,
                    error: format!("Broker rejected unsubscription: {reasons:?}"),
                }),
            },
            _ => Ok(ProtocolEvent::Other),
        }
    }

    async fn poll(&mut self) -> Result<ProtocolEvent, String> {
        match self {
            Self::V3_1_1(eventloop) => eventloop
                .poll()
                .await
                .map_err(|error| error.to_string())
                .and_then(Self::map_v3_event),
            Self::V5_0(eventloop) => eventloop
                .poll()
                .await
                .map_err(|error| error.to_string())
                .and_then(Self::map_v5_event),
        }
    }
}

struct ProtocolConnection {
    client: ProtocolClient,
    eventloop: ProtocolEventLoop,
    protocol_version: MqttProtocolVersion,
}

#[derive(Clone)]
struct ClientHandle {
    connection_id: uuid::Uuid,
    client: ProtocolClient,
    shutdown_tx: mpsc::Sender<()>,
    connected: Arc<AtomicBool>,
    publish_enqueue_gate: Arc<AsyncMutex<()>>,
    publish_tracker: Arc<AsyncMutex<PublishOperationTracker>>,
    subscription_gate: Arc<AsyncMutex<()>>,
    subscription_tracker: Arc<AsyncMutex<SubscriptionOperationTracker>>,
}

struct EventLoopContext {
    server_id: i64,
    connection_id: uuid::Uuid,
    protocol_version: MqttProtocolVersion,
    app_handle: AppHandle,
    clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
    connected_flag: Arc<AtomicBool>,
    publish_tracker: Arc<AsyncMutex<PublishOperationTracker>>,
    subscription_tracker: Arc<AsyncMutex<SubscriptionOperationTracker>>,
}

#[derive(Clone)]
pub struct MqttManager {
    clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
    app_handle: AppHandle,
}

impl MqttManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
        }
    }

    pub async fn connect(
        &self,
        server: MqttServer,
        packet_size_limit: usize,
    ) -> Result<(), String> {
        let server_id = server.id.ok_or("Server ID is required")?;
        let connection = Self::build_connection(&server, packet_size_limit)?;
        let protocol_version = connection.protocol_version;

        // 如果已连接，先断开
        self.disconnect(server_id).await?;

        // 发送连接中状态
        self.emit_state(server_id, "connecting", None, Some(protocol_version));

        let ProtocolConnection {
            client, eventloop, ..
        } = connection;

        // 创建停止信号
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);
        let connection_id = uuid::Uuid::new_v4();
        let connected = Arc::new(AtomicBool::new(false));
        let publish_tracker = Arc::new(AsyncMutex::new(PublishOperationTracker::default()));
        let subscription_tracker =
            Arc::new(AsyncMutex::new(SubscriptionOperationTracker::default()));

        // 保存客户端句柄
        {
            let mut clients = self.clients.write();
            clients.insert(
                server_id,
                ClientHandle {
                    connection_id,
                    client,
                    shutdown_tx,
                    connected: connected.clone(),
                    publish_enqueue_gate: Arc::new(AsyncMutex::new(())),
                    publish_tracker: publish_tracker.clone(),
                    subscription_gate: Arc::new(AsyncMutex::new(())),
                    subscription_tracker: subscription_tracker.clone(),
                },
            );
        }

        // 启动事件循环
        let app_handle = self.app_handle.clone();
        let clients = self.clients.clone();

        tokio::spawn(async move {
            Self::run_eventloop(
                eventloop,
                shutdown_rx,
                EventLoopContext {
                    server_id,
                    connection_id,
                    protocol_version,
                    app_handle,
                    clients,
                    connected_flag: connected,
                    publish_tracker,
                    subscription_tracker,
                },
            )
            .await;
        });

        Ok(())
    }

    async fn run_eventloop(
        mut eventloop: ProtocolEventLoop,
        mut shutdown_rx: mpsc::Receiver<()>,
        context: EventLoopContext,
    ) {
        let EventLoopContext {
            server_id,
            connection_id,
            protocol_version,
            app_handle,
            clients,
            connected_flag,
            publish_tracker,
            subscription_tracker,
        } = context;
        let mut connected = false;

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    connected_flag.store(false, Ordering::Release);
                    Self::fail_pending_subscription(
                        &app_handle,
                        &subscription_tracker,
                        "Connection closed before acknowledgement".to_string(),
                    ).await;
                    Self::fail_pending_publish(
                        &app_handle,
                        &publish_tracker,
                        "Connection closed before acknowledgement".to_string(),
                    ).await;
                    Self::emit_state_static(
                        &app_handle,
                        server_id,
                        "disconnected",
                        None,
                        Some(protocol_version),
                    );
                    break;
                }
                event = eventloop.poll() => {
                    match event {
                        Ok(ProtocolEvent::Connected) => {
                            connected = true;
                            connected_flag.store(true, Ordering::Release);
                            Self::emit_state_static(
                                &app_handle,
                                server_id,
                                "connected",
                                None,
                                Some(protocol_version),
                            );
                        }
                        Ok(ProtocolEvent::ConnectionRefused(code)) => {
                            connected_flag.store(false, Ordering::Release);
                            Self::emit_state_static(
                                &app_handle,
                                server_id,
                                "error",
                                Some(format!("Connection refused: {}", code)),
                                Some(protocol_version),
                            );
                            break;
                        }
                        Ok(ProtocolEvent::Publish {
                            topic,
                            payload,
                            qos,
                            retain,
                        }) => {
                            let msg = ReceivedMessage {
                                server_id,
                                topic,
                                payload,
                                qos,
                                retain,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                            };
                            let _ = app_handle.emit("mqtt-message", msg);
                        }
                        Ok(ProtocolEvent::PublishRequestSent { packet_id }) => {
                            let state = publish_tracker
                                .lock()
                                .await
                                .on_outgoing_publish(packet_id);
                            if let Some(state) = state {
                                Self::emit_publish_state_static(&app_handle, state);
                            }
                        }
                        Ok(ProtocolEvent::PublishAcknowledged {
                            phase,
                            packet_id,
                            outcome,
                        }) => {
                            let diagnostic = format!(
                                "server_id={server_id}, phase={phase:?}, packet_id={packet_id}, outcome={outcome:?}"
                            );
                            let state = {
                                let mut tracker = publish_tracker.lock().await;
                                match phase {
                                    PublishAckPhase::PubAck => tracker.on_puback(packet_id, outcome),
                                    PublishAckPhase::PubRec => tracker.on_pubrec(packet_id, outcome),
                                    PublishAckPhase::PubComp => tracker.on_pubcomp(packet_id, outcome),
                                }
                            };
                            if let Some(state) = state {
                                Self::emit_publish_state_static(&app_handle, state);
                            } else {
                                Self::write_diagnostic(
                                    &app_handle,
                                    "warning",
                                    "Unmatched publish acknowledgement",
                                    Some(diagnostic),
                                );
                            }
                        }
                        Ok(ProtocolEvent::SubscriptionRequestSent { operation, packet_id }) => {
                            subscription_tracker.lock().await.mark_sent(operation, packet_id);
                        }
                        Ok(ProtocolEvent::SubscriptionAcknowledged {
                            operation,
                            packet_id,
                            granted_qos,
                        }) => {
                            let state = subscription_tracker
                                .lock()
                                .await
                                .complete(operation, packet_id, granted_qos);
                            if let Some(state) = state {
                                Self::emit_subscription_state_static(&app_handle, state);
                            }
                        }
                        Ok(ProtocolEvent::SubscriptionRejected {
                            operation,
                            packet_id,
                            error,
                        }) => {
                            let state = subscription_tracker
                                .lock()
                                .await
                                .reject(operation, packet_id, error);
                            if let Some(state) = state {
                                Self::emit_subscription_state_static(&app_handle, state);
                            }
                        }
                        Err(e) => {
                            connected_flag.store(false, Ordering::Release);
                            Self::fail_pending_subscription(
                                &app_handle,
                                &subscription_tracker,
                                format!("Connection closed before acknowledgement: {e}"),
                            ).await;
                            Self::fail_pending_publish(
                                &app_handle,
                                &publish_tracker,
                                format!("Connection closed before acknowledgement: {e}"),
                            ).await;
                            if connected {
                                Self::emit_state_static(
                                    &app_handle,
                                    server_id,
                                    "error",
                                    Some(format!("Connection error: {}", e)),
                                    Some(protocol_version),
                                );
                            } else {
                                Self::emit_state_static(
                                    &app_handle,
                                    server_id,
                                    "error",
                                    Some(format!("Failed to connect: {}", e)),
                                    Some(protocol_version),
                                );
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        // 清理客户端
        let mut clients = clients.write();
        if clients
            .get(&server_id)
            .is_some_and(|handle| handle.connection_id == connection_id)
        {
            clients.remove(&server_id);
        }
    }

    pub async fn disconnect(&self, server_id: i64) -> Result<(), String> {
        let handle = {
            let clients = self.clients.read();
            clients.get(&server_id).map(|h| h.shutdown_tx.clone())
        };

        if let Some(tx) = handle {
            let _ = tx.send(()).await;
        }

        Ok(())
    }

    pub(crate) async fn publish_tracked(
        &self,
        server_id: i64,
        operation_id: String,
        topic: String,
        payload: Vec<u8>,
        qos: u8,
        retain: bool,
    ) -> Result<PublishOperationResult, String> {
        let handle = {
            let clients = self.clients.read();
            clients.get(&server_id).cloned()
        }
        .ok_or("Not connected")?;

        let completion = {
            let _enqueue_guard = handle.publish_enqueue_gate.lock().await;
            if !handle.connected.load(Ordering::Acquire)
                || self.clients.read().get(&server_id).map_or(true, |current| {
                    current.connection_id != handle.connection_id
                })
            {
                return Err("Not connected".to_string());
            }

            let StartedPublishOperation { state, completion } = handle
                .publish_tracker
                .lock()
                .await
                .start(server_id, qos, operation_id.clone())?;
            self.emit_publish_state(state);

            if let Err(error) = handle.client.publish(topic, qos, retain, payload).await {
                let state = handle
                    .publish_tracker
                    .lock()
                    .await
                    .mark_enqueue_failed(&operation_id, error.clone());
                if let Some(state) = state {
                    self.emit_publish_state(state);
                }
                return Err(error);
            }

            completion
        };

        match timeout(PUBLISH_ACK_TIMEOUT, completion).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Publish operation was interrupted".to_string()),
            Err(_) => {
                let error = "Publish acknowledgement timed out".to_string();
                let state = handle
                    .publish_tracker
                    .lock()
                    .await
                    .fail_operation(&operation_id, error.clone());
                if let Some(state) = state {
                    self.emit_publish_state(state);
                }
                Err(error)
            }
        }
    }

    pub async fn subscribe(
        &self,
        server_id: i64,
        topic: String,
        qos: u8,
    ) -> Result<SubscriptionOperationResult, String> {
        self.run_subscription_operation(
            server_id,
            topic,
            SubscriptionRequest::Subscribe { requested_qos: qos },
        )
        .await
    }

    pub async fn unsubscribe(
        &self,
        server_id: i64,
        topic: String,
    ) -> Result<SubscriptionOperationResult, String> {
        self.run_subscription_operation(server_id, topic, SubscriptionRequest::Unsubscribe)
            .await
    }

    async fn run_subscription_operation(
        &self,
        server_id: i64,
        topic: String,
        request: SubscriptionRequest,
    ) -> Result<SubscriptionOperationResult, String> {
        let handle = {
            let clients = self.clients.read();
            clients.get(&server_id).cloned()
        }
        .ok_or("Not connected")?;
        let _operation_guard = handle.subscription_gate.lock().await;

        if !handle.connected.load(Ordering::Acquire)
            || self
                .clients
                .read()
                .get(&server_id)
                .is_none_or(|current| current.connection_id != handle.connection_id)
        {
            return Err("Not connected".to_string());
        }

        let StartedSubscriptionOperation { state, completion } = handle
            .subscription_tracker
            .lock()
            .await
            .start(server_id, topic.clone(), request)?;
        self.emit_subscription_state(state);

        let enqueue_result = match request {
            SubscriptionRequest::Subscribe { requested_qos } => {
                handle.client.subscribe(topic, requested_qos).await
            }
            SubscriptionRequest::Unsubscribe => handle.client.unsubscribe(topic).await,
        };
        if let Err(error) = enqueue_result {
            let state = handle
                .subscription_tracker
                .lock()
                .await
                .fail_current(error.clone());
            if let Some(state) = state {
                self.emit_subscription_state(state);
            }
            return Err(error);
        }

        match timeout(SUBSCRIPTION_ACK_TIMEOUT, completion).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Subscription operation was interrupted".to_string()),
            Err(_) => {
                let error = "Subscription acknowledgement timed out".to_string();
                let state = handle
                    .subscription_tracker
                    .lock()
                    .await
                    .fail_current(error.clone());
                if let Some(state) = state {
                    self.emit_subscription_state(state);
                }
                Err(error)
            }
        }
    }

    fn emit_state(
        &self,
        server_id: i64,
        status: &str,
        error: Option<String>,
        protocol_version: Option<MqttProtocolVersion>,
    ) {
        Self::emit_state_static(&self.app_handle, server_id, status, error, protocol_version);
    }

    fn emit_state_static(
        app_handle: &AppHandle,
        server_id: i64,
        status: &str,
        error: Option<String>,
        protocol_version: Option<MqttProtocolVersion>,
    ) {
        let state = ConnectionState::new(server_id, status, error, protocol_version);
        let _ = app_handle.emit("mqtt-connection-state", state);
    }

    fn emit_subscription_state(&self, state: SubscriptionStateEvent) {
        Self::emit_subscription_state_static(&self.app_handle, state);
    }

    fn emit_publish_state(&self, state: PublishStateEvent) {
        Self::emit_publish_state_static(&self.app_handle, state);
    }

    fn emit_publish_state_static(app_handle: &AppHandle, state: PublishStateEvent) {
        if let Some(storage) = app_handle.try_state::<Storage>() {
            if let Err(error) = storage.update_publish_state(
                &state.operation_id,
                state.status.as_str(),
                state.packet_id,
                state.error.as_deref(),
            ) {
                Self::write_diagnostic(
                    app_handle,
                    "error",
                    "Failed to persist publish state",
                    Some(format!(
                        "operation_id={}, status={}, error={error}",
                        state.operation_id,
                        state.status.as_str()
                    )),
                );
            }
        }
        let _ = app_handle.emit("mqtt-publish-state", state);
    }

    fn write_diagnostic(
        app_handle: &AppHandle,
        entry_type: &str,
        message: &str,
        details: Option<String>,
    ) {
        let Some(log_manager) = app_handle.try_state::<LogManager>() else {
            return;
        };
        let _ = log_manager.write_log(&LogEntry {
            r#type: entry_type.to_string(),
            message: message.to_string(),
            details,
            timestamp: chrono::Utc::now().to_rfc3339(),
        });
    }

    fn emit_subscription_state_static(app_handle: &AppHandle, state: SubscriptionStateEvent) {
        let _ = app_handle.emit("mqtt-subscription-state", state);
    }

    async fn fail_pending_subscription(
        app_handle: &AppHandle,
        subscription_tracker: &AsyncMutex<SubscriptionOperationTracker>,
        error: String,
    ) {
        let state = subscription_tracker.lock().await.fail_current(error);
        if let Some(state) = state {
            Self::emit_subscription_state_static(app_handle, state);
        }
    }

    async fn fail_pending_publish(
        app_handle: &AppHandle,
        publish_tracker: &AsyncMutex<PublishOperationTracker>,
        error: String,
    ) {
        let states = publish_tracker.lock().await.fail_all(error);
        for state in states {
            Self::emit_publish_state_static(app_handle, state);
        }
    }

    pub fn is_connected(&self, server_id: i64) -> bool {
        let clients = self.clients.read();
        clients
            .get(&server_id)
            .is_some_and(|handle| handle.connected.load(Ordering::Acquire))
    }

    fn build_connection(
        server: &MqttServer,
        packet_size_limit: usize,
    ) -> Result<ProtocolConnection, String> {
        let protocol_version = MqttProtocolVersion::try_from(server.protocol_version.as_str())?;
        if server.keep_alive < 0 {
            return Err("MQTT keep alive cannot be negative".to_string());
        }
        if protocol_version == MqttProtocolVersion::V5_0 && server.keep_alive < 5 {
            return Err("MQTT 5.0 keep alive must be at least 5 seconds".to_string());
        }

        let protocol =
            server
                .protocol
                .as_deref()
                .unwrap_or(if server.use_tls { "mqtts" } else { "mqtt" });
        let broker_addr = Self::broker_addr(server, protocol);
        let client_id = server
            .client_id
            .clone()
            .unwrap_or_else(|| format!("mqtt_client_{}", uuid::Uuid::new_v4()));
        let transport = Self::build_transport(server, protocol)?;

        match protocol_version {
            MqttProtocolVersion::V3_1_1 => {
                let mut options = V3MqttOptions::new(client_id, broker_addr, server.port as u16);
                options.set_keep_alive(Duration::from_secs(server.keep_alive as u64));
                options.set_clean_session(server.clean_session);
                options.set_max_packet_size(packet_size_limit, packet_size_limit);
                if let Some(transport) = transport {
                    options.set_transport(transport);
                }
                if let (Some(username), Some(password)) =
                    (server.username.as_ref(), server.password.as_ref())
                {
                    if !username.is_empty() {
                        options.set_credentials(username, password);
                    }
                }

                let (client, eventloop) = V3AsyncClient::new(options, 100);
                Ok(ProtocolConnection {
                    client: ProtocolClient::V3_1_1(client),
                    eventloop: ProtocolEventLoop::V3_1_1(Box::new(eventloop)),
                    protocol_version,
                })
            }
            MqttProtocolVersion::V5_0 => {
                let packet_size_limit = u32::try_from(packet_size_limit)
                    .map_err(|_| "MQTT packet size limit exceeds MQTT 5.0 range".to_string())?;
                let mut options = V5MqttOptions::new(client_id, broker_addr, server.port as u16);
                options.set_keep_alive(Duration::from_secs(server.keep_alive as u64));
                options.set_clean_start(server.clean_session);
                options.set_max_packet_size(Some(packet_size_limit));
                if let Some(transport) = transport {
                    options.set_transport(transport);
                }
                if let (Some(username), Some(password)) =
                    (server.username.as_ref(), server.password.as_ref())
                {
                    if !username.is_empty() {
                        options.set_credentials(username, password);
                    }
                }

                let (client, eventloop) = V5AsyncClient::new(options, 100);
                Ok(ProtocolConnection {
                    client: ProtocolClient::V5_0(client),
                    eventloop: ProtocolEventLoop::V5_0(Box::new(eventloop)),
                    protocol_version,
                })
            }
        }
    }

    fn build_transport(server: &MqttServer, protocol: &str) -> Result<Option<Transport>, String> {
        match protocol {
            "mqtt" => Ok(None),
            "mqtts" => Self::build_tls_config(
                server.ssl_secure,
                server.alpn.as_deref(),
                server.certificate_type.as_str(),
                server.ca_cert.as_deref(),
                server.client_cert.as_deref(),
                server.client_key.as_deref(),
                server.client_key_password.as_deref(),
            )
            .map(Transport::tls_with_config)
            .map(Some),
            "ws" => Ok(Some(Transport::Ws)),
            "wss" => Self::build_tls_config(
                server.ssl_secure,
                server.alpn.as_deref(),
                server.certificate_type.as_str(),
                server.ca_cert.as_deref(),
                server.client_cert.as_deref(),
                server.client_key.as_deref(),
                server.client_key_password.as_deref(),
            )
            .map(Transport::wss_with_config)
            .map(Some),
            protocol => Err(format!("Unsupported MQTT transport protocol: {}", protocol)),
        }
    }

    fn broker_addr(server: &MqttServer, protocol: &str) -> String {
        if !matches!(protocol, "ws" | "wss") {
            return server.host.clone();
        }

        let base_url = format!("{}://{}:{}", protocol, server.host, server.port);
        let Some(path) = server
            .websocket_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        else {
            return base_url;
        };

        if path.starts_with('/') {
            format!("{}{}", base_url, path)
        } else {
            format!("{}/{}", base_url, path)
        }
    }

    /// 构建 TLS 配置
    fn build_tls_config(
        ssl_secure: bool,
        alpn: Option<&str>,
        certificate_type: &str,
        ca_cert: Option<&str>,
        client_cert: Option<&str>,
        client_key: Option<&str>,
        client_key_password: Option<&str>,
    ) -> Result<rumqttc::TlsConfiguration, String> {
        use std::io::BufReader;

        let mut root_cert_store = rumqttc::tokio_rustls::rustls::RootCertStore::empty();

        let native_certs = rustls_native_certs::load_native_certs();
        for cert in native_certs.certs {
            let _ = root_cert_store.add(cert);
        }

        let use_custom_certificates = certificate_type == "self_signed";
        if use_custom_certificates {
            if let Some(ca_pem) = ca_cert {
                if !ca_pem.trim().is_empty() {
                    let mut reader = BufReader::new(ca_pem.as_bytes());
                    for cert in rustls_pemfile::certs(&mut reader) {
                        let cert =
                            cert.map_err(|e| format!("Failed to parse CA certificate: {}", e))?;
                        root_cert_store
                            .add(cert)
                            .map_err(|e| format!("Failed to add CA certificate: {}", e))?;
                    }
                }
            }
        }

        let client_cert = if use_custom_certificates {
            client_cert
        } else {
            None
        };
        let client_key = if use_custom_certificates {
            client_key
        } else {
            None
        };
        let provider = Arc::new(rumqttc::tokio_rustls::rustls::crypto::ring::default_provider());
        let builder = rumqttc::tokio_rustls::rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| format!("Failed to configure TLS protocol versions: {error}"))?;

        let mut client_config = if ssl_secure {
            let builder = builder.with_root_certificates(root_cert_store);
            match (client_cert, client_key) {
                (Some(cert_pem), Some(key_pem))
                    if !cert_pem.trim().is_empty() && !key_pem.trim().is_empty() =>
                {
                    let mut cert_reader = BufReader::new(cert_pem.as_bytes());
                    let mut certs = Vec::new();
                    for cert in rustls_pemfile::certs(&mut cert_reader) {
                        let cert =
                            cert.map_err(|e| format!("Failed to parse client certificate: {}", e))?;
                        certs.push(cert);
                    }

                    let key = Self::parse_private_key(key_pem, client_key_password)?;

                    builder
                        .with_client_auth_cert(certs, key)
                        .map_err(|e| format!("Failed to configure client auth: {}", e))?
                }
                _ => builder.with_no_client_auth(),
            }
        } else {
            let builder = builder
                .dangerous()
                .with_custom_certificate_verifier(NoCertificateVerification::new());
            match (client_cert, client_key) {
                (Some(cert_pem), Some(key_pem))
                    if !cert_pem.trim().is_empty() && !key_pem.trim().is_empty() =>
                {
                    let mut cert_reader = BufReader::new(cert_pem.as_bytes());
                    let mut certs = Vec::new();
                    for cert in rustls_pemfile::certs(&mut cert_reader) {
                        let cert =
                            cert.map_err(|e| format!("Failed to parse client certificate: {}", e))?;
                        certs.push(cert);
                    }

                    let key = Self::parse_private_key(key_pem, client_key_password)?;

                    builder
                        .with_client_auth_cert(certs, key)
                        .map_err(|e| format!("Failed to configure client auth: {}", e))?
                }
                _ => builder.with_no_client_auth(),
            }
        };

        if let Some(protocols) = Self::parse_alpn_protocols(alpn) {
            client_config.alpn_protocols = protocols;
        }

        Ok(rumqttc::TlsConfiguration::Rustls(Arc::new(client_config)))
    }

    fn parse_alpn_protocols(alpn: Option<&str>) -> Option<Vec<Vec<u8>>> {
        let protocols = alpn?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.as_bytes().to_vec())
            .collect::<Vec<_>>();

        if protocols.is_empty() {
            None
        } else {
            Some(protocols)
        }
    }

    /// 解析私钥，支持加密和未加密格式
    fn parse_private_key(
        key_pem: &str,
        password: Option<&str>,
    ) -> Result<rumqttc::tokio_rustls::rustls::pki_types::PrivateKeyDer<'static>, String> {
        use pkcs8::der::Decode;
        use rumqttc::tokio_rustls::rustls::pki_types::PrivateKeyDer;
        use std::io::BufReader;

        // 首先尝试解析未加密的私钥
        let mut key_reader = BufReader::new(key_pem.as_bytes());
        if let Ok(Some(key)) = rustls_pemfile::private_key(&mut key_reader) {
            return Ok(key);
        }

        // 如果提供了密码，尝试解析加密的私钥
        if let Some(pwd) = password {
            if !pwd.is_empty() {
                // 尝试从 PEM 解析加密的私钥
                let pem = pem::parse(key_pem).map_err(|e| format!("Failed to parse PEM: {}", e))?;

                if pem.tag() == "ENCRYPTED PRIVATE KEY" {
                    // 解析加密的 PKCS#8
                    let encrypted = pkcs8::EncryptedPrivateKeyInfo::from_der(pem.contents())
                        .map_err(|e| format!("Failed to parse encrypted private key: {}", e))?;

                    let decrypted = encrypted.decrypt(pwd).map_err(|e| {
                        format!("Failed to decrypt private key (wrong password?): {}", e)
                    })?;

                    let der_bytes = decrypted.as_bytes().to_vec();

                    return Ok(PrivateKeyDer::Pkcs8(der_bytes.into()));
                }
            }
        }

        Err("No valid private key found in PEM. If the key is encrypted, please provide the password.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectionState, MqttCapability, MqttManager, MqttProtocolVersion, ProtocolEvent,
        ProtocolEventLoop,
    };
    use crate::db::models::MqttServer;
    use crate::mqtt::publish::{PublishAckOutcome, PublishAckPhase, PublishOperationTracker};
    use crate::mqtt::subscription::{
        SubscriptionOperation, SubscriptionOperationTracker, SubscriptionRequest,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    fn server(protocol: &str, websocket_path: Option<&str>) -> MqttServer {
        MqttServer {
            id: Some(1),
            name: "test".to_string(),
            host: "broker.example.com".to_string(),
            port: 8083,
            protocol: Some(protocol.to_string()),
            websocket_path: websocket_path.map(str::to_string),
            protocol_version: "5.0".to_string(),
            username: None,
            password: None,
            client_id: None,
            keep_alive: 60,
            clean_session: true,
            use_tls: false,
            ssl_secure: true,
            alpn: None,
            certificate_type: "ca_signed".to_string(),
            ca_cert: None,
            client_cert: None,
            client_key: None,
            client_key_password: None,
            created_at: None,
            updated_at: None,
        }
    }

    async fn capture_connect_protocol_level(protocol_version: &str) -> u8 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = address.port() as i32;
        server.protocol_version = protocol_version.to_string();

        let connection = MqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let poll_task = tokio::spawn(async move {
            let _ = eventloop.poll().await;
        });

        let (mut socket, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("client did not connect")
            .unwrap();
        let mut packet_prefix = [0_u8; 9];
        timeout(
            Duration::from_secs(2),
            socket.read_exact(&mut packet_prefix),
        )
        .await
        .expect("client did not send CONNECT")
        .unwrap();
        poll_task.abort();

        assert_eq!(&packet_prefix[2..8], b"\0\x04MQTT");
        packet_prefix[8]
    }

    async fn read_mqtt_packet(socket: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
        let packet_type = socket.read_u8().await.unwrap();
        let mut remaining_length = 0_usize;
        let mut multiplier = 1_usize;
        loop {
            let byte = socket.read_u8().await.unwrap();
            remaining_length += usize::from(byte & 0x7f) * multiplier;
            if byte & 0x80 == 0 {
                break;
            }
            multiplier *= 128;
        }

        let mut payload = vec![0_u8; remaining_length];
        socket.read_exact(&mut payload).await.unwrap();
        (packet_type, payload)
    }

    #[tokio::test]
    async fn mqtt_5_selection_sends_protocol_level_5() {
        assert_eq!(capture_connect_protocol_level("5.0").await, 5);
    }

    #[tokio::test]
    async fn mqtt_311_selection_sends_protocol_level_4() {
        assert_eq!(capture_connect_protocol_level("3.1.1").await, 4);
    }

    #[test]
    fn unsupported_protocol_version_is_rejected_before_connecting() {
        let mut server = server("mqtt", None);
        server.protocol_version = "4.0".to_string();

        let error = MqttManager::build_connection(&server, 1024)
            .err()
            .expect("unsupported version should fail");

        assert_eq!(
            error,
            "Unsupported MQTT protocol version: 4.0. Supported versions: 3.1.1, 5.0"
        );
    }

    #[test]
    fn mqtt_5_capabilities_are_not_enabled_for_mqtt_311() {
        for capability in [
            MqttCapability::PublishProperties,
            MqttCapability::SessionExpiry,
            MqttCapability::TopicAlias,
        ] {
            assert!(MqttProtocolVersion::V5_0.supports(capability));
            assert!(!MqttProtocolVersion::V3_1_1.supports(capability));
        }
    }

    #[test]
    fn mqtt_5_keep_alive_below_library_minimum_is_rejected() {
        let mut server = server("mqtt", None);
        server.keep_alive = 4;

        let error = MqttManager::build_connection(&server, 1024)
            .err()
            .expect("invalid keep alive should fail");

        assert_eq!(error, "MQTT 5.0 keep alive must be at least 5 seconds");
    }

    #[test]
    fn connection_state_reports_actual_protocol_version() {
        let state = ConnectionState::new(1, "connected", None, Some(MqttProtocolVersion::V5_0));

        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["protocol_version"], "5.0");
        assert_eq!(
            json["capabilities"],
            serde_json::json!(["publish_properties", "session_expiry", "topic_alias"])
        );
    }

    #[test]
    fn websocket_broker_addr_appends_path() {
        assert_eq!(
            MqttManager::broker_addr(&server("ws", Some("mqtt")), "ws"),
            "ws://broker.example.com:8083/mqtt"
        );
        assert_eq!(
            MqttManager::broker_addr(&server("wss", Some("/mqtt")), "wss"),
            "wss://broker.example.com:8083/mqtt"
        );
    }

    #[test]
    fn broker_addr_ignores_empty_or_tcp_paths() {
        assert_eq!(
            MqttManager::broker_addr(&server("ws", Some("   ")), "ws"),
            "ws://broker.example.com:8083"
        );
        assert_eq!(
            MqttManager::broker_addr(&server("mqtt", Some("mqtt")), "mqtt"),
            "broker.example.com"
        );
    }

    #[test]
    fn parse_alpn_protocols_ignores_empty_values() {
        assert_eq!(
            MqttManager::parse_alpn_protocols(Some("mqtt, x-amzn-mqtt-ca,  ")),
            Some(vec![b"mqtt".to_vec(), b"x-amzn-mqtt-ca".to_vec()])
        );
        assert_eq!(MqttManager::parse_alpn_protocols(Some("  ")), None);
    }

    #[test]
    fn ca_signed_mode_ignores_custom_certificate_fields() {
        let tls_config = MqttManager::build_tls_config(
            true,
            Some("mqtt"),
            "ca_signed",
            Some("not-a-valid-cert"),
            Some("not-a-valid-cert"),
            Some("not-a-valid-key"),
            None,
        );

        assert!(tls_config.is_ok());
    }

    #[test]
    fn mqtt_311_suback_exposes_packet_id_and_granted_qos() {
        let event = ProtocolEventLoop::map_v3_event(rumqttc::Event::Incoming(
            rumqttc::Packet::SubAck(rumqttc::SubAck::new(
                41,
                vec![rumqttc::SubscribeReasonCode::Success(
                    rumqttc::QoS::AtLeastOnce,
                )],
            )),
        ))
        .unwrap();

        assert!(matches!(
            event,
            ProtocolEvent::SubscriptionAcknowledged {
                operation: SubscriptionOperation::Subscribe,
                packet_id: 41,
                granted_qos: Some(1),
            }
        ));
    }

    #[test]
    fn mqtt_311_publish_events_expose_packet_ids() {
        let sent = ProtocolEventLoop::map_v3_event(rumqttc::Event::Outgoing(
            rumqttc::Outgoing::Publish(41),
        ))
        .unwrap();
        assert!(matches!(
            sent,
            ProtocolEvent::PublishRequestSent { packet_id: 41 }
        ));

        let acknowledged = ProtocolEventLoop::map_v3_event(rumqttc::Event::Incoming(
            rumqttc::Packet::PubAck(rumqttc::PubAck::new(41)),
        ))
        .unwrap();
        assert!(matches!(
            acknowledged,
            ProtocolEvent::PublishAcknowledged {
                phase: PublishAckPhase::PubAck,
                packet_id: 41,
                outcome: PublishAckOutcome::Success,
            }
        ));
    }

    #[test]
    fn mqtt_5_publish_rejection_preserves_reason() {
        use rumqttc::v5::mqttbytes::v5::{Packet, PubAck, PubAckReason};

        let event =
            ProtocolEventLoop::map_v5_event(rumqttc::v5::Event::Incoming(Packet::PubAck(PubAck {
                pkid: 23,
                reason: PubAckReason::NotAuthorized,
                properties: None,
            })))
            .unwrap();

        assert!(matches!(
            event,
            ProtocolEvent::PublishAcknowledged {
                phase: PublishAckPhase::PubAck,
                packet_id: 23,
                outcome: PublishAckOutcome::Rejected(error),
            } if error.contains("NotAuthorized")
        ));
    }

    #[test]
    fn mqtt_5_suback_exposes_packet_id_and_granted_qos() {
        use rumqttc::v5::mqttbytes::v5::{Packet, SubAck, SubscribeReasonCode};
        use rumqttc::v5::mqttbytes::QoS;

        let event =
            ProtocolEventLoop::map_v5_event(rumqttc::v5::Event::Incoming(Packet::SubAck(SubAck {
                pkid: 17,
                return_codes: vec![SubscribeReasonCode::Success(QoS::AtMostOnce)],
                properties: None,
            })))
            .unwrap();

        assert!(matches!(
            event,
            ProtocolEvent::SubscriptionAcknowledged {
                operation: SubscriptionOperation::Subscribe,
                packet_id: 17,
                granted_qos: Some(0),
            }
        ));
    }

    #[test]
    fn mqtt_5_rejection_is_classified_as_subscription_failure() {
        use rumqttc::v5::mqttbytes::v5::SubscribeReasonCode;

        let event = ProtocolEventLoop::map_v5_event(rumqttc::v5::Event::Incoming(
            rumqttc::v5::mqttbytes::v5::Packet::SubAck(rumqttc::v5::mqttbytes::v5::SubAck {
                pkid: 23,
                return_codes: vec![SubscribeReasonCode::NotAuthorized],
                properties: None,
            }),
        ))
        .unwrap();

        assert!(matches!(
            event,
            ProtocolEvent::SubscriptionRejected {
                operation: SubscriptionOperation::Subscribe,
                packet_id: 23,
                error,
            } if error.contains("NotAuthorized")
        ));
    }

    #[test]
    fn mqtt_5_missing_subscription_is_a_successful_unsubscribe() {
        use rumqttc::v5::mqttbytes::v5::{Packet, UnsubAck, UnsubAckReason};

        let event = ProtocolEventLoop::map_v5_event(rumqttc::v5::Event::Incoming(
            Packet::UnsubAck(UnsubAck {
                pkid: 29,
                reasons: vec![UnsubAckReason::NoSubscriptionExisted],
                properties: None,
            }),
        ))
        .unwrap();

        assert!(matches!(
            event,
            ProtocolEvent::SubscriptionAcknowledged {
                operation: SubscriptionOperation::Unsubscribe,
                packet_id: 29,
                granted_qos: None,
            }
        ));
    }

    #[tokio::test]
    async fn subscribe_stays_pending_until_broker_suback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_ack, wait_for_release) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let (packet_type, subscribe) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 8);
            let packet_id = u16::from_be_bytes([subscribe[0], subscribe[1]]);
            wait_for_release.await.unwrap();
            socket
                .write_all(&[0x90, 0x03, (packet_id >> 8) as u8, packet_id as u8, 0x01])
                .await
                .unwrap();
            wait_for_test.await.unwrap();
        });

        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();
        let connection = MqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected)
        ));
        let mut tracker = SubscriptionOperationTracker::default();
        let mut started = tracker
            .start(
                1,
                "sensor/+".to_string(),
                SubscriptionRequest::Subscribe { requested_qos: 2 },
            )
            .unwrap();
        client.subscribe("sensor/+".to_string(), 2).await.unwrap();

        let sent = eventloop.poll().await.unwrap();
        let ProtocolEvent::SubscriptionRequestSent {
            operation,
            packet_id,
        } = sent
        else {
            panic!("expected outgoing SUBSCRIBE event");
        };
        assert!(tracker.mark_sent(operation, packet_id));
        assert!(started.completion.try_recv().is_err());

        release_ack.send(()).unwrap();
        let ack = eventloop.poll().await.unwrap();
        let ProtocolEvent::SubscriptionAcknowledged {
            operation,
            packet_id,
            granted_qos,
        } = ack
        else {
            panic!("expected incoming SUBACK event");
        };
        let state = tracker.complete(operation, packet_id, granted_qos).unwrap();
        let result = started.completion.await.unwrap().unwrap();

        assert_eq!(state.granted_qos, Some(1));
        assert_eq!(result.granted_qos, Some(1));
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn qos1_publish_completes_only_after_broker_puback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_ack, wait_for_release) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let (packet_type, publish) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 3);
            let topic_length = usize::from(u16::from_be_bytes([publish[0], publish[1]]));
            let packet_id_offset = 2 + topic_length;
            let packet_id =
                u16::from_be_bytes([publish[packet_id_offset], publish[packet_id_offset + 1]]);
            wait_for_release.await.unwrap();
            socket
                .write_all(&[0x40, 0x02, (packet_id >> 8) as u8, packet_id as u8])
                .await
                .unwrap();
            wait_for_test.await.unwrap();
        });

        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();
        let connection = MqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected)
        ));
        let mut tracker = PublishOperationTracker::default();
        let mut started = tracker.start(1, 1, "op-qos1-broker".to_string()).unwrap();
        client
            .publish("tracked/topic".to_string(), 1, false, b"payload".to_vec())
            .await
            .unwrap();

        let sent = eventloop.poll().await.unwrap();
        let ProtocolEvent::PublishRequestSent { packet_id } = sent else {
            panic!("expected outgoing PUBLISH event");
        };
        tracker.on_outgoing_publish(packet_id).unwrap();
        assert!(started.completion.try_recv().is_err());

        release_ack.send(()).unwrap();
        let acknowledged = eventloop.poll().await.unwrap();
        let ProtocolEvent::PublishAcknowledged {
            phase: PublishAckPhase::PubAck,
            packet_id: acknowledged_packet_id,
            outcome,
        } = acknowledged
        else {
            panic!("expected incoming PUBACK event");
        };
        assert_eq!(acknowledged_packet_id, packet_id);
        tracker.on_puback(acknowledged_packet_id, outcome).unwrap();
        let result = started.completion.await.unwrap().unwrap();
        assert_eq!(result.packet_id, Some(packet_id));

        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn mqtt_5_rejected_suback_does_not_reset_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket
                .write_all(&[0x20, 0x03, 0x00, 0x00, 0x00])
                .await
                .unwrap();

            let (packet_type, subscribe) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 8);
            let packet_id = u16::from_be_bytes([subscribe[0], subscribe[1]]);
            socket
                .write_all(&[
                    0x90,
                    0x04,
                    (packet_id >> 8) as u8,
                    packet_id as u8,
                    0x00,
                    0x87,
                ])
                .await
                .unwrap();

            let (packet_type, _) = timeout(Duration::from_secs(2), read_mqtt_packet(&mut socket))
                .await
                .expect("client reset the connection after rejected SUBACK");
            assert_eq!(packet_type >> 4, 3);
        });

        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "5.0".to_string();
        let connection = MqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected)
        ));
        client
            .subscribe("restricted/topic".to_string(), 1)
            .await
            .unwrap();

        let sent = eventloop.poll().await.unwrap();
        let ProtocolEvent::SubscriptionRequestSent {
            operation,
            packet_id,
        } = sent
        else {
            panic!("expected outgoing SUBSCRIBE event");
        };
        assert_eq!(operation, SubscriptionOperation::Subscribe);

        let rejected = eventloop.poll().await;
        assert!(matches!(
            rejected,
            Ok(ProtocolEvent::SubscriptionRejected {
                operation: SubscriptionOperation::Subscribe,
                packet_id: rejected_packet_id,
                error,
            }) if rejected_packet_id == packet_id && error.contains("NotAuthorized")
        ));

        client
            .publish("still/connected".to_string(), 0, false, b"ok".to_vec())
            .await
            .unwrap();
        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::PublishRequestSent { packet_id: 0 })
        ));
        broker.await.unwrap();
    }
}
