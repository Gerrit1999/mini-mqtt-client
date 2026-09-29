use crate::db::models::MqttServer;

const MAX_MQTT_TOPIC_BYTES: usize = u16::MAX as usize;
const MAX_MQTT_KEEP_ALIVE: i32 = u16::MAX as i32;

pub fn validate_host(host: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("服务器地址不能为空".to_string());
    }
    Ok(())
}

pub fn validate_port(port: i32) -> Result<(), String> {
    if !(1..=u16::MAX as i32).contains(&port) {
        return Err(format!("端口号必须在 1 到 65535 之间，当前为 {port}"));
    }
    Ok(())
}

pub fn validate_keep_alive(keep_alive: i32) -> Result<(), String> {
    if !(0..=MAX_MQTT_KEEP_ALIVE).contains(&keep_alive) {
        return Err(format!(
            "Keep Alive 必须在 0 到 65535 秒之间，当前为 {keep_alive}"
        ));
    }
    Ok(())
}

pub fn validate_qos(qos: i32) -> Result<(), String> {
    if !(0..=2).contains(&qos) {
        return Err(format!("QoS 必须为 0、1 或 2，当前为 {qos}"));
    }
    Ok(())
}

pub fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.trim().is_empty() {
        return Err("Topic 不能为空".to_string());
    }
    if topic.len() > MAX_MQTT_TOPIC_BYTES {
        return Err("Topic 长度超过 65535 字节限制".to_string());
    }
    if topic.contains('\0') {
        return Err("Topic 不能包含空字符".to_string());
    }

    let levels: Vec<&str> = topic.split('/').collect();
    let last_level = levels.len() - 1;
    for (index, level) in levels.iter().enumerate() {
        if level.contains('#') && (*level != "#" || index != last_level) {
            return Err("# 通配符只能单独占据主题末尾层级".to_string());
        }
        if level.contains('+') && *level != "+" {
            return Err("+ 通配符必须单独占据一个主题层级".to_string());
        }
    }
    Ok(())
}

pub fn validate_server(server: &MqttServer) -> Result<(), String> {
    if server.name.trim().is_empty() {
        return Err("服务器名称不能为空".to_string());
    }
    validate_host(&server.host)?;
    validate_port(server.port)?;
    validate_keep_alive(server.keep_alive)
}

pub fn validate_subscription(topic: &str, qos: i32) -> Result<(), String> {
    validate_topic(topic)?;
    validate_qos(qos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(port: i32, keep_alive: i32) -> MqttServer {
        MqttServer {
            id: None,
            name: "test".to_string(),
            host: "localhost".to_string(),
            port,
            protocol: Some("mqtt".to_string()),
            websocket_path: None,
            protocol_version: "5.0".to_string(),
            username: None,
            password: None,
            client_id: None,
            keep_alive,
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
    fn validates_server_boundaries() {
        assert!(validate_server(&server(1, 0)).is_ok());
        assert!(validate_server(&server(65535, 65535)).is_ok());
        for invalid in [0, -1, 65536] {
            assert!(validate_port(invalid).is_err());
        }
        assert!(validate_keep_alive(-1).is_err());
        assert!(validate_keep_alive(65536).is_err());
        assert!(validate_server(&MqttServer {
            name: " ".to_string(),
            ..server(1883, 60)
        })
        .is_err());
    }

    #[test]
    fn validates_qos_and_topics() {
        assert!(validate_subscription("sensors/+/temperature", 0).is_ok());
        assert!(validate_subscription("sensors/#", 2).is_ok());
        assert!(validate_subscription("#", 1).is_ok());
        for qos in [-1, 3] {
            assert!(validate_qos(qos).is_err());
        }
        for topic in ["", " ", "a\0b", "a#", "a/#/b", "a/+b", "a/b+"] {
            assert!(
                validate_topic(topic).is_err(),
                "topic should be rejected: {topic:?}"
            );
        }
        assert!(validate_topic(&"é".repeat(32768)).is_err());
    }
}
