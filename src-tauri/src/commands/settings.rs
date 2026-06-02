use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::db::{
    Storage, MAX_MESSAGE_LIMIT, MAX_MQTT_PACKET_SIZE_LIMIT_KB, MIN_MESSAGE_LIMIT,
    MIN_MQTT_PACKET_SIZE_LIMIT_KB,
};

#[derive(Debug, serde::Serialize)]
pub struct AppSettings {
    pub message_limit: usize,
    pub mqtt_packet_size_limit_kb: usize,
}

#[tauri::command]
pub fn get_app_settings(storage: tauri::State<Storage>) -> Result<AppSettings, String> {
    Ok(AppSettings {
        message_limit: storage.get_message_limit(),
        mqtt_packet_size_limit_kb: storage.get_mqtt_packet_size_limit_kb(),
    })
}

#[tauri::command]
pub fn update_message_limit(
    storage: tauri::State<Storage>,
    message_limit: usize,
) -> Result<AppSettings, String> {
    if !(MIN_MESSAGE_LIMIT..=MAX_MESSAGE_LIMIT).contains(&message_limit) {
        return Err(format!(
            "Message limit must be between {} and {}",
            MIN_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT
        ));
    }

    storage.set_message_limit(message_limit)?;

    Ok(AppSettings {
        message_limit: storage.get_message_limit(),
        mqtt_packet_size_limit_kb: storage.get_mqtt_packet_size_limit_kb(),
    })
}

#[tauri::command]
pub fn update_mqtt_packet_size_limit(
    storage: tauri::State<Storage>,
    mqtt_packet_size_limit_kb: usize,
) -> Result<AppSettings, String> {
    if !(MIN_MQTT_PACKET_SIZE_LIMIT_KB..=MAX_MQTT_PACKET_SIZE_LIMIT_KB)
        .contains(&mqtt_packet_size_limit_kb)
    {
        return Err(format!(
            "MQTT packet size limit must be between {} KB and {} KB",
            MIN_MQTT_PACKET_SIZE_LIMIT_KB, MAX_MQTT_PACKET_SIZE_LIMIT_KB
        ));
    }

    storage.set_mqtt_packet_size_limit_kb(mqtt_packet_size_limit_kb)?;

    Ok(AppSettings {
        message_limit: storage.get_message_limit(),
        mqtt_packet_size_limit_kb: storage.get_mqtt_packet_size_limit_kb(),
    })
}

/// 获取当前数据存储路径
#[tauri::command]
pub fn get_data_path(storage: tauri::State<Storage>) -> Result<String, String> {
    Ok(storage.get_file_path().to_string_lossy().to_string())
}

/// 迁移数据到新路径
#[tauri::command]
pub fn migrate_data_path(
    storage: tauri::State<Storage>,
    new_path: String,
    migrate: bool,
) -> Result<(), String> {
    let new_path = PathBuf::from(&new_path);

    // 验证新路径
    if !new_path.is_absolute() {
        return Err("Please provide an absolute path".to_string());
    }

    // 确保目标目录存在
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // 如果需要迁移，复制当前数据到新位置
    if migrate {
        let current_path = storage.get_file_path();
        if current_path.exists() {
            fs::copy(current_path, &new_path)
                .map_err(|e| format!("Failed to copy data file: {}", e))?;
        }
    }

    storage.set_data_path(new_path.to_string_lossy().to_string())?;

    Ok(())
}

/// 选择文件夹对话框
#[tauri::command]
pub async fn select_data_folder(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = app_handle
        .dialog()
        .file()
        .set_title("Select Data Directory")
        .blocking_pick_folder();

    match folder {
        Some(file_path) => {
            // FilePath 需要转换为 PathBuf
            let path_buf = file_path.as_path().ok_or("Invalid path")?;
            let data_file = path_buf.join("data.yaml");
            Ok(Some(data_file.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}
