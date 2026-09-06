use crate::db::models::MqttServer;
use crate::db::Storage;
use crate::mqtt::MqttManager;
use tauri::State;

#[tauri::command]
pub async fn get_servers(storage: State<'_, Storage>) -> Result<Vec<MqttServer>, String> {
    Ok(storage.get_servers())
}

#[tauri::command]
pub async fn create_server(storage: State<'_, Storage>, server: MqttServer) -> Result<i64, String> {
    storage.create_server(server)
}

#[tauri::command]
pub async fn update_server(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    server: MqttServer,
) -> Result<(), String> {
    if let Some(server_id) = server.id {
        mqtt_manager.disconnect(server_id).await?;
    }
    storage.update_server(server)
}

#[tauri::command]
pub async fn delete_server(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    id: i64,
) -> Result<(), String> {
    mqtt_manager.disconnect(id).await?;
    storage.delete_server(id)
}

#[tauri::command]
pub async fn get_server(
    storage: State<'_, Storage>,
    id: i64,
) -> Result<Option<MqttServer>, String> {
    Ok(storage.get_server(id))
}
