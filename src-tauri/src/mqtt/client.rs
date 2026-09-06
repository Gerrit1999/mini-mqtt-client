use parking_lot::{Mutex, RwLock};
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::db::{
    models::{MqttServer, Subscription},
    Storage,
};
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
const RECONNECT_BASE_DELAY: Duration = Duration::from_millis(500);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
struct ReconnectPolicy {
    base_delay: Duration,
    max_delay: Duration,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            base_delay: RECONNECT_BASE_DELAY,
            max_delay: RECONNECT_MAX_DELAY,
        }
    }
}

impl ReconnectPolicy {
    fn delay(self, attempt: u32, jitter_seed: u64) -> Duration {
        let exponent = attempt.saturating_sub(1).min(31);
        let multiplier = 1_u128 << exponent;
        let capped_ms = self
            .base_delay
            .as_millis()
            .saturating_mul(multiplier)
            .min(self.max_delay.as_millis()) as u64;
        let minimum_ms = capped_ms / 2;
        let jitter_range = capped_ms - minimum_ms;
        let jitter_ms = jitter_seed % (jitter_range + 1);

        Duration::from_millis(minimum_ms + jitter_ms)
    }
}

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
    pub status: String,
    pub error: Option<String>,
    pub protocol_version: Option<MqttProtocolVersion>,
    pub capabilities: Vec<MqttCapability>,
    pub reconnect_attempt: Option<u32>,
    pub retry_in_ms: Option<u64>,
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
            reconnect_attempt: None,
            retry_in_ms: None,
        }
    }

    fn reconnecting(
        server_id: i64,
        error: String,
        protocol_version: MqttProtocolVersion,
        reconnect_attempt: u32,
        retry_delay: Duration,
    ) -> Self {
        let mut state = Self::new(
            server_id,
            "reconnecting",
            Some(error),
            Some(protocol_version),
        );
        state.reconnect_attempt = Some(reconnect_attempt);
        state.retry_in_ms = Some(retry_delay.as_millis().min(u128::from(u64::MAX)) as u64);
        state
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
    Connected {
        session_present: bool,
    },
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
                    Ok(ProtocolEvent::Connected {
                        session_present: ack.session_present,
                    })
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
                    Ok(ProtocolEvent::Connected {
                        session_present: ack.session_present,
                    })
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
    client: Arc<RwLock<Option<ProtocolClient>>>,
    shutdown_tx: watch::Sender<bool>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
    connected: Arc<AtomicBool>,
    publish_enqueue_gate: Arc<AsyncMutex<()>>,
    publish_tracker: Arc<AsyncMutex<PublishOperationTracker>>,
    subscription_gate: Arc<AsyncMutex<()>>,
    subscription_tracker: Arc<AsyncMutex<SubscriptionOperationTracker>>,
}

struct EventLoopContext<R: Runtime> {
    server_id: i64,
    connection_id: uuid::Uuid,
    server: MqttServer,
    packet_size_limit: usize,
    app_handle: AppHandle<R>,
    clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
    client: Arc<RwLock<Option<ProtocolClient>>>,
    connected_flag: Arc<AtomicBool>,
    publish_tracker: Arc<AsyncMutex<PublishOperationTracker>>,
    subscription_tracker: Arc<AsyncMutex<SubscriptionOperationTracker>>,
    subscription_loader: SubscriptionLoader,
    connection_generation: Arc<AtomicU64>,
    jitter_seed: u64,
}

type SubscriptionLoader = Arc<dyn Fn(i64) -> Vec<Subscription> + Send + Sync>;

pub struct MqttManager<R: Runtime = Wry> {
    clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
    app_handle: AppHandle<R>,
    subscription_loader: SubscriptionLoader,
}

impl<R: Runtime> Clone for MqttManager<R> {
    fn clone(&self) -> Self {
        Self {
            clients: self.clients.clone(),
            app_handle: self.app_handle.clone(),
            subscription_loader: self.subscription_loader.clone(),
        }
    }
}

impl<R: Runtime> MqttManager<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        let storage_handle = app_handle.clone();
        Self::new_with_subscription_loader(
            app_handle,
            Arc::new(move |server_id| {
                storage_handle
                    .try_state::<Storage>()
                    .map(|storage| storage.get_subscriptions(server_id))
                    .unwrap_or_default()
            }),
        )
    }

    fn new_with_subscription_loader(
        app_handle: AppHandle<R>,
        subscription_loader: SubscriptionLoader,
    ) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
            subscription_loader,
        }
    }

    pub async fn connect(
        &self,
        mut server: MqttServer,
        packet_size_limit: usize,
    ) -> Result<(), String> {
        let server_id = server.id.ok_or("Server ID is required")?;
        if server
            .client_id
            .as_deref()
            .is_none_or(|client_id| client_id.trim().is_empty())
        {
            server.client_id = Some(format!("mqtt_client_{}", uuid::Uuid::new_v4()));
        }
        let connection = Self::build_connection(&server, packet_size_limit)?;
        let protocol_version = connection.protocol_version;

        // 如果已连接，先断开
        self.disconnect(server_id).await?;

        // 发送连接中状态
        self.emit_state(server_id, "connecting", None, Some(protocol_version));

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let connection_id = uuid::Uuid::new_v4();
        let client = Arc::new(RwLock::new(None));
        let task = Arc::new(Mutex::new(None));
        let connected = Arc::new(AtomicBool::new(false));
        let connection_generation = Arc::new(AtomicU64::new(0));
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
                    client: client.clone(),
                    shutdown_tx,
                    task: task.clone(),
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
        let subscription_loader = self.subscription_loader.clone();

        let spawned_task = tokio::spawn(async move {
            Self::run_eventloop(
                connection,
                shutdown_rx,
                EventLoopContext {
                    server_id,
                    connection_id,
                    server,
                    packet_size_limit,
                    app_handle,
                    clients,
                    client,
                    connected_flag: connected,
                    publish_tracker,
                    subscription_tracker,
                    subscription_loader,
                    connection_generation,
                    jitter_seed: connection_id.as_u128() as u64,
                },
            )
            .await;
        });
        task.lock().replace(spawned_task);

        Ok(())
    }

    async fn run_eventloop(
        mut connection: ProtocolConnection,
        mut shutdown_rx: watch::Receiver<bool>,
        context: EventLoopContext<R>,
    ) {
        let EventLoopContext {
            server_id,
            connection_id,
            server,
            packet_size_limit,
            app_handle,
            clients,
            client,
            connected_flag,
            publish_tracker,
            subscription_tracker,
            subscription_loader,
            connection_generation,
            jitter_seed,
        } = context;
        let reconnect_policy = ReconnectPolicy::default();
        let mut reconnect_attempt = 0_u32;
        let mut cancelled = false;

        'supervisor: loop {
            let generation = connection_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            let ProtocolConnection {
                client: protocol_client,
                mut eventloop,
                protocol_version,
            } = connection;
            *client.write() = Some(protocol_client);
            let mut connected = false;
            let failure = loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            cancelled = true;
                            break None;
                        }
                    }
                    event = eventloop.poll() => {
                        match event {
                        Ok(ProtocolEvent::Connected { session_present }) => {
                            connected = true;
                            reconnect_attempt = 0;
                            connected_flag.store(true, Ordering::Release);
                            Self::emit_state_static(
                                &app_handle,
                                server_id,
                                "connected",
                                None,
                                Some(protocol_version),
                            );
                            if !session_present {
                                Self::restore_subscriptions(
                                    app_handle.clone(),
                                    clients.clone(),
                                    subscription_loader.clone(),
                                    server_id,
                                    connection_id,
                                    generation,
                                    connection_generation.clone(),
                                );
                            }
                        }
                        Ok(ProtocolEvent::ConnectionRefused(code)) => {
                            break Some(format!("Connection refused: {code}"));
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
                            if connected {
                                break Some(format!("Connection error: {e}"));
                            } else {
                                break Some(format!("Failed to connect: {e}"));
                            }
                        }
                        _ => {}
                    }
                }
                }
            };

            connected_flag.store(false, Ordering::Release);
            *client.write() = None;

            let Some(error) = failure else {
                break 'supervisor;
            };
            let operation_error = format!("Connection closed before acknowledgement: {error}");
            Self::fail_pending_subscription(
                &app_handle,
                &subscription_tracker,
                operation_error.clone(),
            )
            .await;
            Self::fail_pending_publish(&app_handle, &publish_tracker, operation_error).await;

            reconnect_attempt = reconnect_attempt.saturating_add(1);
            let delay = reconnect_policy.delay(
                reconnect_attempt,
                jitter_seed.wrapping_add(u64::from(reconnect_attempt)),
            );
            Self::emit_reconnecting_state_static(
                &app_handle,
                server_id,
                error,
                protocol_version,
                reconnect_attempt,
                delay,
            );

            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        cancelled = true;
                        break 'supervisor;
                    }
                }
                _ = sleep(delay) => {}
            }

            match Self::build_connection(&server, packet_size_limit) {
                Ok(next_connection) => connection = next_connection,
                Err(error) => {
                    Self::emit_state_static(
                        &app_handle,
                        server_id,
                        "error",
                        Some(error),
                        Some(protocol_version),
                    );
                    break 'supervisor;
                }
            }
        }

        connected_flag.store(false, Ordering::Release);
        *client.write() = None;
        if cancelled {
            Self::fail_pending_subscription(
                &app_handle,
                &subscription_tracker,
                "Connection closed before acknowledgement".to_string(),
            )
            .await;
            Self::fail_pending_publish(
                &app_handle,
                &publish_tracker,
                "Connection closed before acknowledgement".to_string(),
            )
            .await;
            Self::emit_state_static(
                &app_handle,
                server_id,
                "disconnected",
                None,
                Some(connection.protocol_version),
            );
        }

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
            clients.get(&server_id).cloned()
        };

        if let Some(handle) = handle {
            let _ = handle.shutdown_tx.send(true);
            let task = handle.task.lock().take();
            if let Some(task) = task {
                let _ = task.await;
            }
        }

        Ok(())
    }

    fn restore_subscriptions(
        app_handle: AppHandle<R>,
        clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
        subscription_loader: SubscriptionLoader,
        server_id: i64,
        connection_id: uuid::Uuid,
        generation: u64,
        connection_generation: Arc<AtomicU64>,
    ) {
        let subscriptions = subscription_loader(server_id)
            .into_iter()
            .filter(|subscription| subscription.is_active)
            .collect::<Vec<_>>();
        if subscriptions.is_empty() {
            return;
        }

        let manager = Self {
            clients,
            app_handle,
            subscription_loader,
        };
        tokio::spawn(async move {
            for subscription in subscriptions {
                let is_current = manager
                    .clients
                    .read()
                    .get(&server_id)
                    .is_some_and(|handle| {
                        handle.connection_id == connection_id
                            && handle.connected.load(Ordering::Acquire)
                            && connection_generation.load(Ordering::Acquire) == generation
                    });
                if !is_current {
                    break;
                }

                let current_subscription = (manager.subscription_loader)(server_id)
                    .into_iter()
                    .find(|current| {
                        current.is_active
                            && match subscription.id {
                                Some(id) => current.id == Some(id),
                                None => current.topic == subscription.topic,
                            }
                    });
                let Some(current_subscription) = current_subscription else {
                    continue;
                };

                if manager
                    .subscribe(
                        server_id,
                        current_subscription.topic,
                        current_subscription.qos as u8,
                    )
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
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
                || self
                    .clients
                    .read()
                    .get(&server_id)
                    .is_none_or(|current| current.connection_id != handle.connection_id)
            {
                return Err("Not connected".to_string());
            }
            let client = handle.client.read().clone().ok_or("Not connected")?;

            let StartedPublishOperation { state, completion } = handle
                .publish_tracker
                .lock()
                .await
                .start(server_id, qos, operation_id.clone())?;
            self.emit_publish_state(state);

            if let Err(error) = client.publish(topic, qos, retain, payload).await {
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
        let client = handle.client.read().clone().ok_or("Not connected")?;

        let StartedSubscriptionOperation { state, completion } = handle
            .subscription_tracker
            .lock()
            .await
            .start(server_id, topic.clone(), request)?;
        self.emit_subscription_state(state);

        let enqueue_result = match request {
            SubscriptionRequest::Subscribe { requested_qos } => {
                client.subscribe(topic, requested_qos).await
            }
            SubscriptionRequest::Unsubscribe => client.unsubscribe(topic).await,
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
        app_handle: &AppHandle<R>,
        server_id: i64,
        status: &str,
        error: Option<String>,
        protocol_version: Option<MqttProtocolVersion>,
    ) {
        let state = ConnectionState::new(server_id, status, error, protocol_version);
        let _ = app_handle.emit("mqtt-connection-state", state);
    }

    fn emit_reconnecting_state_static(
        app_handle: &AppHandle<R>,
        server_id: i64,
        error: String,
        protocol_version: MqttProtocolVersion,
        reconnect_attempt: u32,
        retry_delay: Duration,
    ) {
        let state = ConnectionState::reconnecting(
            server_id,
            error,
            protocol_version,
            reconnect_attempt,
            retry_delay,
        );
        let _ = app_handle.emit("mqtt-connection-state", state);
    }

    fn emit_subscription_state(&self, state: SubscriptionStateEvent) {
        Self::emit_subscription_state_static(&self.app_handle, state);
    }

    fn emit_publish_state(&self, state: PublishStateEvent) {
        Self::emit_publish_state_static(&self.app_handle, state);
    }

    fn emit_publish_state_static(app_handle: &AppHandle<R>, state: PublishStateEvent) {
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
        app_handle: &AppHandle<R>,
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

    fn emit_subscription_state_static(app_handle: &AppHandle<R>, state: SubscriptionStateEvent) {
        let _ = app_handle.emit("mqtt-subscription-state", state);
    }

    async fn fail_pending_subscription(
        app_handle: &AppHandle<R>,
        subscription_tracker: &AsyncMutex<SubscriptionOperationTracker>,
        error: String,
    ) {
        let state = subscription_tracker.lock().await.fail_current(error);
        if let Some(state) = state {
            Self::emit_subscription_state_static(app_handle, state);
        }
    }

    async fn fail_pending_publish(
        app_handle: &AppHandle<R>,
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
                if !server.clean_session {
                    options.set_session_expiry_interval(Some(u32::MAX));
                }
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
        ProtocolEventLoop, ReconnectPolicy,
    };
    use crate::db::models::{MqttServer, Subscription};
    use crate::mqtt::publish::{PublishAckOutcome, PublishAckPhase, PublishOperationTracker};
    use crate::mqtt::subscription::{
        SubscriptionOperation, SubscriptionOperationTracker, SubscriptionRequest,
    };
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::time::{sleep, timeout};

    type ProductionMqttManager = MqttManager<tauri::Wry>;

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

        let connection = ProductionMqttManager::build_connection(&server, 1024).unwrap();
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

    #[tokio::test]
    async fn mqtt_5_persistent_session_sets_session_expiry_interval() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.clean_session = false;

        let connection = ProductionMqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let poll_task = tokio::spawn(async move {
            let _ = eventloop.poll().await;
        });

        let (mut socket, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("client did not connect")
            .unwrap();
        let (packet_type, connect) = read_mqtt_packet(&mut socket).await;
        poll_task.abort();

        assert_eq!(packet_type >> 4, 1);
        assert_eq!(connect[7] & 0x02, 0, "clean start should be disabled");
        assert!(
            connect
                .windows(5)
                .any(|property| property == [0x11, 0xff, 0xff, 0xff, 0xff]),
            "CONNECT should request a persistent MQTT 5 session"
        );
    }

    #[tokio::test]
    async fn unexpected_disconnect_reconnects_until_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (second_connection, wait_for_second_connection) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut first).await;
            assert_eq!(packet_type >> 4, 1);
            first.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut second).await;
            assert_eq!(packet_type >> 4, 1);
            second.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            second_connection.send(()).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let manager = MqttManager::new(app.handle().clone());
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        timeout(Duration::from_secs(2), wait_for_second_connection)
            .await
            .expect("client did not reconnect")
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while !manager.is_connected(1) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("reconnected client did not become ready");

        manager.disconnect(1).await.unwrap();
        assert!(!manager.is_connected(1));
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn repeated_connection_failures_eventually_recover() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (recovered, wait_for_recovery) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (packet_type, _) = read_mqtt_packet(&mut socket).await;
                assert_eq!(packet_type >> 4, 1);
                drop(socket);
            }

            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            recovered.send(()).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let manager = MqttManager::new(app.handle().clone());
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        timeout(Duration::from_secs(3), wait_for_recovery)
            .await
            .expect("client did not recover after repeated connection failures")
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while !manager.is_connected(1) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("recovered client did not become ready");

        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn reconnect_with_fresh_session_restores_enabled_subscriptions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (subscription_received, wait_for_subscription) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x01, 0x00]).await.unwrap();
            drop(socket);

            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            let (packet_type, subscribe) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 8);
            let packet_id = u16::from_be_bytes([subscribe[0], subscribe[1]]);
            socket
                .write_all(&[0x90, 0x03, (packet_id >> 8) as u8, packet_id as u8, 0x01])
                .await
                .unwrap();
            subscription_received.send(()).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let subscriptions = vec![Subscription {
            id: Some(1),
            server_id: 1,
            topic: "restored/topic".to_string(),
            qos: 1,
            is_active: true,
            color: None,
            created_at: None,
        }];
        let manager = MqttManager::new_with_subscription_loader(
            app.handle().clone(),
            Arc::new(move |_| subscriptions.clone()),
        );
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();
        server.clean_session = false;

        manager.connect(server, 1024).await.unwrap();
        timeout(Duration::from_secs(2), wait_for_subscription)
            .await
            .expect("fresh reconnect did not restore the enabled subscription")
            .unwrap();

        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn reconnect_with_resumed_session_does_not_resubmit_subscriptions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (result_tx, result_rx) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x01, 0x00]).await.unwrap();
            drop(socket);

            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x01, 0x00]).await.unwrap();
            let subscription_received =
                timeout(Duration::from_millis(300), read_mqtt_packet(&mut socket))
                    .await
                    .is_ok();
            result_tx.send(!subscription_received).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let subscriptions = vec![Subscription {
            id: Some(1),
            server_id: 1,
            topic: "existing/topic".to_string(),
            qos: 1,
            is_active: true,
            color: None,
            created_at: None,
        }];
        let manager = MqttManager::new_with_subscription_loader(
            app.handle().clone(),
            Arc::new(move |_| subscriptions.clone()),
        );
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();
        server.clean_session = false;

        manager.connect(server, 1024).await.unwrap();
        let session_was_respected = timeout(Duration::from_secs(2), result_rx)
            .await
            .expect("broker did not finish observing the resumed reconnect")
            .unwrap();
        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();

        assert!(session_was_respected);
    }

    #[tokio::test]
    async fn disconnect_during_backoff_prevents_another_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (connection_dropped, wait_for_drop) = oneshot::channel();
        let (result_tx, result_rx) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            drop(socket);
            connection_dropped.send(()).unwrap();

            let reconnected = timeout(Duration::from_millis(600), listener.accept())
                .await
                .is_ok();
            result_tx.send(!reconnected).unwrap();
        });

        let app = tauri::test::mock_app();
        let manager = MqttManager::new(app.handle().clone());
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        timeout(Duration::from_secs(1), wait_for_drop)
            .await
            .expect("broker did not close the initial connection")
            .unwrap();
        manager.disconnect(1).await.unwrap();

        assert!(timeout(Duration::from_secs(1), result_rx)
            .await
            .expect("broker did not finish observing reconnect attempts")
            .unwrap());
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn reconnect_supervisors_are_isolated_per_server() {
        let first_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_address = first_listener.local_addr().unwrap();
        let second_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_address = second_listener.local_addr().unwrap();
        let (first_reconnected, wait_for_first_reconnect) = oneshot::channel();
        let (second_published, wait_for_second_publish) = oneshot::channel();
        let (finish_first, wait_for_first_finish) = oneshot::channel();
        let (finish_second, wait_for_second_finish) = oneshot::channel();

        let first_broker = tokio::spawn(async move {
            let (mut socket, _) = first_listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            drop(socket);

            let (mut socket, _) = first_listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            first_reconnected.send(()).unwrap();
            wait_for_first_finish.await.unwrap();
        });
        let second_broker = tokio::spawn(async move {
            let (mut socket, _) = second_listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 3);
            second_published.send(()).unwrap();
            wait_for_second_finish.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let manager = MqttManager::new(app.handle().clone());
        let mut first_server = server("mqtt", None);
        first_server.host = first_address.ip().to_string();
        first_server.port = i32::from(first_address.port());
        first_server.protocol_version = "3.1.1".to_string();
        let mut second_server = server("mqtt", None);
        second_server.id = Some(2);
        second_server.host = second_address.ip().to_string();
        second_server.port = i32::from(second_address.port());
        second_server.protocol_version = "3.1.1".to_string();

        manager.connect(first_server, 1024).await.unwrap();
        manager.connect(second_server, 1024).await.unwrap();
        timeout(Duration::from_secs(2), wait_for_first_reconnect)
            .await
            .expect("first server did not reconnect")
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while !manager.is_connected(2) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("second server did not become ready");

        manager.disconnect(1).await.unwrap();
        assert!(manager.is_connected(2));
        manager
            .publish_tracked(
                2,
                "isolation-check".to_string(),
                "still/connected".to_string(),
                b"ok".to_vec(),
                0,
                false,
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(1), wait_for_second_publish)
            .await
            .expect("second server stopped processing after first server was cancelled")
            .unwrap();

        manager.disconnect(2).await.unwrap();
        finish_first.send(()).unwrap();
        finish_second.send(()).unwrap();
        first_broker.await.unwrap();
        second_broker.await.unwrap();
    }

    #[tokio::test]
    async fn fresh_session_restores_enabled_subscriptions_from_storage_intent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (subscription_received, wait_for_subscription) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let (packet_type, subscribe) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 8);
            let packet_id = u16::from_be_bytes([subscribe[0], subscribe[1]]);
            socket
                .write_all(&[0x90, 0x03, (packet_id >> 8) as u8, packet_id as u8, 0x01])
                .await
                .unwrap();
            subscription_received.send(()).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let subscriptions = vec![
            Subscription {
                id: Some(1),
                server_id: 1,
                topic: "enabled/topic".to_string(),
                qos: 1,
                is_active: true,
                color: None,
                created_at: None,
            },
            Subscription {
                id: Some(2),
                server_id: 1,
                topic: "disabled/topic".to_string(),
                qos: 0,
                is_active: false,
                color: None,
                created_at: None,
            },
        ];
        let manager = MqttManager::new_with_subscription_loader(
            app.handle().clone(),
            Arc::new(move |_| subscriptions.clone()),
        );
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        timeout(Duration::from_secs(1), wait_for_subscription)
            .await
            .expect("enabled subscription was not restored")
            .unwrap();

        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn resumed_session_does_not_resubmit_subscriptions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (no_subscription, wait_for_result) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x01, 0x00]).await.unwrap();

            let received_packet =
                timeout(Duration::from_millis(200), read_mqtt_packet(&mut socket))
                    .await
                    .is_ok();
            no_subscription.send(!received_packet).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let subscriptions = vec![Subscription {
            id: Some(1),
            server_id: 1,
            topic: "enabled/topic".to_string(),
            qos: 1,
            is_active: true,
            color: None,
            created_at: None,
        }];
        let manager = MqttManager::new_with_subscription_loader(
            app.handle().clone(),
            Arc::new(move |_| subscriptions.clone()),
        );
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        assert!(timeout(Duration::from_secs(1), wait_for_result)
            .await
            .expect("broker did not finish observing the resumed session")
            .unwrap());

        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();
    }

    #[tokio::test]
    async fn subscription_restore_rechecks_current_storage_intent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (result_tx, result_rx) = oneshot::channel();
        let (finish_test, wait_for_test) = oneshot::channel();
        let broker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (packet_type, _) = read_mqtt_packet(&mut socket).await;
            assert_eq!(packet_type >> 4, 1);
            socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let subscription_received =
                timeout(Duration::from_millis(300), read_mqtt_packet(&mut socket))
                    .await
                    .is_ok();
            result_tx.send(!subscription_received).unwrap();
            wait_for_test.await.unwrap();
        });

        let app = tauri::test::mock_app();
        let load_count = Arc::new(AtomicUsize::new(0));
        let manager = MqttManager::new_with_subscription_loader(
            app.handle().clone(),
            Arc::new(move |_| {
                let is_active = load_count.fetch_add(1, AtomicOrdering::SeqCst) == 0;
                vec![Subscription {
                    id: Some(1),
                    server_id: 1,
                    topic: "changing/topic".to_string(),
                    qos: 1,
                    is_active,
                    color: None,
                    created_at: None,
                }]
            }),
        );
        let mut server = server("mqtt", None);
        server.host = address.ip().to_string();
        server.port = i32::from(address.port());
        server.protocol_version = "3.1.1".to_string();

        manager.connect(server, 1024).await.unwrap();
        let intent_was_respected = timeout(Duration::from_secs(1), result_rx)
            .await
            .expect("broker did not finish observing subscription restoration")
            .unwrap();
        manager.disconnect(1).await.unwrap();
        finish_test.send(()).unwrap();
        broker.await.unwrap();

        assert!(intent_was_respected);
    }

    #[test]
    fn unsupported_protocol_version_is_rejected_before_connecting() {
        let mut server = server("mqtt", None);
        server.protocol_version = "4.0".to_string();

        let error = ProductionMqttManager::build_connection(&server, 1024)
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

        let error = ProductionMqttManager::build_connection(&server, 1024)
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
    fn reconnecting_state_reports_attempt_error_and_delay() {
        let state = ConnectionState::reconnecting(
            1,
            "network unavailable".to_string(),
            MqttProtocolVersion::V3_1_1,
            3,
            Duration::from_millis(1_750),
        );

        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["status"], "reconnecting");
        assert_eq!(json["error"], "network unavailable");
        assert_eq!(json["reconnect_attempt"], 3);
        assert_eq!(json["retry_in_ms"], 1_750);
    }

    #[test]
    fn successful_connack_preserves_session_present() {
        let resumed =
            ProtocolEventLoop::map_v3_event(rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(
                rumqttc::ConnAck::new(rumqttc::ConnectReturnCode::Success, true),
            )))
            .unwrap();

        assert!(matches!(
            resumed,
            ProtocolEvent::Connected {
                session_present: true
            }
        ));
    }

    #[test]
    fn reconnect_backoff_is_capped_and_jittered() {
        let policy = ReconnectPolicy::default();

        assert_eq!(policy.delay(1, 0), Duration::from_millis(250));
        assert_eq!(policy.delay(2, 500), Duration::from_millis(1_000));
        assert_eq!(policy.delay(20, 0), Duration::from_secs(15));
        assert_eq!(policy.delay(20, 15_000), Duration::from_secs(30));
    }

    #[test]
    fn websocket_broker_addr_appends_path() {
        assert_eq!(
            ProductionMqttManager::broker_addr(&server("ws", Some("mqtt")), "ws"),
            "ws://broker.example.com:8083/mqtt"
        );
        assert_eq!(
            ProductionMqttManager::broker_addr(&server("wss", Some("/mqtt")), "wss"),
            "wss://broker.example.com:8083/mqtt"
        );
    }

    #[test]
    fn broker_addr_ignores_empty_or_tcp_paths() {
        assert_eq!(
            ProductionMqttManager::broker_addr(&server("ws", Some("   ")), "ws"),
            "ws://broker.example.com:8083"
        );
        assert_eq!(
            ProductionMqttManager::broker_addr(&server("mqtt", Some("mqtt")), "mqtt"),
            "broker.example.com"
        );
    }

    #[test]
    fn parse_alpn_protocols_ignores_empty_values() {
        assert_eq!(
            ProductionMqttManager::parse_alpn_protocols(Some("mqtt, x-amzn-mqtt-ca,  ")),
            Some(vec![b"mqtt".to_vec(), b"x-amzn-mqtt-ca".to_vec()])
        );
        assert_eq!(
            ProductionMqttManager::parse_alpn_protocols(Some("  ")),
            None
        );
    }

    #[test]
    fn ca_signed_mode_ignores_custom_certificate_fields() {
        let tls_config = ProductionMqttManager::build_tls_config(
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
        let connection = ProductionMqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected { .. })
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
        let connection = ProductionMqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected { .. })
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
        let connection = ProductionMqttManager::build_connection(&server, 1024).unwrap();
        let mut eventloop = connection.eventloop;
        let client = connection.client;

        assert!(matches!(
            eventloop.poll().await,
            Ok(ProtocolEvent::Connected { .. })
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
