use parking_lot::RwLock;
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Packet, QoS, Transport};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::db::models::MqttServer;

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

struct ClientHandle {
    client: AsyncClient,
    shutdown_tx: mpsc::Sender<()>,
}

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

        // 如果已连接，先断开
        self.disconnect(server_id).await?;

        // 发送连接中状态
        self.emit_state(server_id, "connecting", None);

        // 构建 MQTT 配置
        let protocol =
            server
                .protocol
                .as_deref()
                .unwrap_or(if server.use_tls { "mqtts" } else { "mqtt" });
        let broker_addr = Self::broker_addr(&server, protocol);
        let client_id = server
            .client_id
            .unwrap_or_else(|| format!("mqtt_client_{}", uuid::Uuid::new_v4()));

        let mut options = MqttOptions::new(client_id, broker_addr, server.port as u16);
        options.set_keep_alive(Duration::from_secs(server.keep_alive as u64));
        options.set_clean_session(server.clean_session);
        options.set_max_packet_size(packet_size_limit, packet_size_limit);

        if let (Some(username), Some(password)) =
            (server.username.as_ref(), server.password.as_ref())
        {
            if !username.is_empty() {
                options.set_credentials(username, password);
            }
        }

        match protocol {
            "mqtt" => {}
            "mqtts" => {
                let tls_config = Self::build_tls_config(
                    server.ssl_secure,
                    server.alpn.as_deref(),
                    server.certificate_type.as_str(),
                    server.ca_cert.as_deref(),
                    server.client_cert.as_deref(),
                    server.client_key.as_deref(),
                    server.client_key_password.as_deref(),
                )?;
                options.set_transport(Transport::tls_with_config(tls_config));
            }
            "ws" => {
                options.set_transport(Transport::Ws);
            }
            "wss" => {
                let tls_config = Self::build_tls_config(
                    server.ssl_secure,
                    server.alpn.as_deref(),
                    server.certificate_type.as_str(),
                    server.ca_cert.as_deref(),
                    server.client_cert.as_deref(),
                    server.client_key.as_deref(),
                    server.client_key_password.as_deref(),
                )?;
                options.set_transport(Transport::wss_with_config(tls_config));
            }
            protocol => {
                return Err(format!("Unsupported MQTT transport protocol: {}", protocol));
            }
        }

        // 创建客户端
        let (client, eventloop) = AsyncClient::new(options, 100);

        // 创建停止信号
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        // 保存客户端句柄
        {
            let mut clients = self.clients.write();
            clients.insert(
                server_id,
                ClientHandle {
                    client: client.clone(),
                    shutdown_tx,
                },
            );
        }

        // 启动事件循环
        let app_handle = self.app_handle.clone();
        let clients = self.clients.clone();

        tokio::spawn(async move {
            Self::run_eventloop(server_id, eventloop, shutdown_rx, app_handle, clients).await;
        });

        Ok(())
    }

    async fn run_eventloop(
        server_id: i64,
        mut eventloop: EventLoop,
        mut shutdown_rx: mpsc::Receiver<()>,
        app_handle: AppHandle,
        clients: Arc<RwLock<HashMap<i64, ClientHandle>>>,
    ) {
        let mut connected = false;

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    Self::emit_state_static(&app_handle, server_id, "disconnected", None);
                    break;
                }
                event = eventloop.poll() => {
                    match event {
                        Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                            if ack.code == rumqttc::ConnectReturnCode::Success {
                                connected = true;
                                Self::emit_state_static(&app_handle, server_id, "connected", None);
                            } else {
                                Self::emit_state_static(
                                    &app_handle,
                                    server_id,
                                    "error",
                                    Some(format!("Connection refused: {:?}", ack.code)),
                                );
                                break;
                            }
                        }
                        Ok(Event::Incoming(Packet::Publish(publish))) => {
                            let msg = ReceivedMessage {
                                server_id,
                                topic: publish.topic.clone(),
                                payload: publish.payload.to_vec(),
                                qos: publish.qos as u8,
                                retain: publish.retain,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                            };
                            let _ = app_handle.emit("mqtt-message", msg);
                        }
                        Ok(Event::Incoming(Packet::SubAck(_))) => {
                            // 订阅成功
                        }
                        Ok(Event::Incoming(Packet::PingResp)) => {
                            // Ping 响应
                        }
                        Err(e) => {
                            if connected {
                                Self::emit_state_static(
                                    &app_handle,
                                    server_id,
                                    "error",
                                    Some(format!("Connection error: {}", e)),
                                );
                            } else {
                                Self::emit_state_static(
                                    &app_handle,
                                    server_id,
                                    "error",
                                    Some(format!("Failed to connect: {}", e)),
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
        clients.remove(&server_id);
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

    pub async fn publish(
        &self,
        server_id: i64,
        topic: String,
        payload: Vec<u8>,
        qos: u8,
        retain: bool,
    ) -> Result<(), String> {
        let client = {
            let clients = self.clients.read();
            clients.get(&server_id).map(|h| h.client.clone())
        };

        let client = client.ok_or("Not connected")?;

        let qos = match qos {
            0 => QoS::AtMostOnce,
            1 => QoS::AtLeastOnce,
            2 => QoS::ExactlyOnce,
            _ => return Err("Invalid QoS".to_string()),
        };

        client
            .publish(topic, qos, retain, payload)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn subscribe(&self, server_id: i64, topic: String, qos: u8) -> Result<(), String> {
        let client = {
            let clients = self.clients.read();
            clients.get(&server_id).map(|h| h.client.clone())
        };

        let client = client.ok_or("Not connected")?;

        let qos = match qos {
            0 => QoS::AtMostOnce,
            1 => QoS::AtLeastOnce,
            2 => QoS::ExactlyOnce,
            _ => return Err("Invalid QoS".to_string()),
        };

        client
            .subscribe(topic, qos)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn unsubscribe(&self, server_id: i64, topic: String) -> Result<(), String> {
        let client = {
            let clients = self.clients.read();
            clients.get(&server_id).map(|h| h.client.clone())
        };

        let client = client.ok_or("Not connected")?;

        client.unsubscribe(topic).await.map_err(|e| e.to_string())
    }

    fn emit_state(&self, server_id: i64, status: &str, error: Option<String>) {
        Self::emit_state_static(&self.app_handle, server_id, status, error);
    }

    fn emit_state_static(
        app_handle: &AppHandle,
        server_id: i64,
        status: &str,
        error: Option<String>,
    ) {
        let state = ConnectionState {
            server_id,
            status: status.to_string(),
            error,
        };
        let _ = app_handle.emit("mqtt-connection-state", state);
    }

    pub fn is_connected(&self, server_id: i64) -> bool {
        let clients = self.clients.read();
        clients.contains_key(&server_id)
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
        let builder = rumqttc::tokio_rustls::rustls::ClientConfig::builder();

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
    use super::MqttManager;
    use crate::db::models::MqttServer;

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
}
