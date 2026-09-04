use crate::db::models::{MessageCleanupResult, MessageHistory, PublishPayload};
use crate::db::Storage;
use crate::mqtt::{MqttManager, PublishRuntimeStatus};
use tauri::State;

#[tauri::command]
pub async fn publish_message(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    server_id: i64,
    message: PublishPayload,
) -> Result<MessageHistory, String> {
    let operation_id = message.operation_id.trim().to_string();
    if operation_id.is_empty() {
        return Err("Publish operation ID is required".to_string());
    }
    if !(0..=2).contains(&message.qos) {
        return Err("Invalid QoS".to_string());
    }

    let payload_bytes = match message.format.as_str() {
        "hex" => hex::decode(message.payload.replace(" ", ""))
            .map_err(|e| format!("HEX decode failed: {}", e))?,
        _ => message.payload.as_bytes().to_vec(),
    };

    let history = MessageHistory {
        id: None,
        server_id,
        topic: message.topic.clone(),
        payload: Some(message.payload),
        payload_format: Some(message.format),
        direction: "publish".to_string(),
        qos: message.qos,
        retain: message.retain,
        created_at: None,
        operation_id: Some(operation_id.clone()),
        publish_status: Some(PublishRuntimeStatus::Pending.as_str().to_string()),
        packet_id: None,
        publish_error: None,
        sent_at: None,
        confirmed_at: None,
    };
    storage.create_message(history)?;

    match mqtt_manager
        .publish_tracked(
            server_id,
            operation_id.clone(),
            message.topic,
            payload_bytes,
            message.qos as u8,
            message.retain,
        )
        .await
    {
        Ok(result) => storage.update_publish_state(
            &operation_id,
            result.status.as_str(),
            result.packet_id,
            None,
        ),
        Err(error) => {
            if let Err(persistence_error) = storage.update_publish_state(
                &operation_id,
                PublishRuntimeStatus::Failed.as_str(),
                None,
                Some(&error),
            ) {
                return Err(format!(
                    "{error}; failed to persist publish failure: {persistence_error}"
                ));
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn save_received_message(
    storage: State<'_, Storage>,
    server_id: i64,
    topic: String,
    payload: String,
    payload_format: String,
    qos: i32,
    retain: bool,
    timestamp: Option<String>,
) -> Result<MessageHistory, String> {
    let history = MessageHistory {
        id: None,
        server_id,
        topic,
        payload: Some(payload),
        payload_format: Some(payload_format),
        direction: "receive".to_string(),
        qos,
        retain,
        created_at: timestamp,
        operation_id: None,
        publish_status: None,
        packet_id: None,
        publish_error: None,
        sent_at: None,
        confirmed_at: None,
    };

    storage.create_message(history)
}

#[tauri::command]
pub async fn get_message_history(
    storage: State<'_, Storage>,
    server_id: i64,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<MessageHistory>, String> {
    Ok(storage.get_messages(server_id, limit.unwrap_or(100), offset.unwrap_or(0)))
}

#[tauri::command]
pub async fn clear_message_history(
    storage: State<'_, Storage>,
    server_id: i64,
) -> Result<(), String> {
    storage.clear_messages(server_id)
}

#[tauri::command]
pub async fn cleanup_message_history(
    storage: State<'_, Storage>,
    vacuum: Option<bool>,
) -> Result<MessageCleanupResult, String> {
    storage.cleanup_message_history(vacuum.unwrap_or(false))
}
