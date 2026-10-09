use crate::log::{LogEntry, LogManager};
use tauri::State;

/// 写入错误日志
#[tauri::command]
pub fn write_error_log(entry: LogEntry, log_manager: State<'_, LogManager>) -> Result<(), String> {
    log_manager.write_log(&entry)
}

/// 批量写入错误日志（空批次不触碰磁盘）
#[tauri::command]
pub fn write_error_logs(
    entries: Vec<LogEntry>,
    log_manager: State<'_, LogManager>,
) -> Result<(), String> {
    log_manager.write_logs(&entries)
}

/// 获取最近的日志
#[tauri::command]
pub fn get_recent_logs(
    limit: Option<usize>,
    log_manager: State<'_, LogManager>,
) -> Result<Vec<String>, String> {
    log_manager.get_recent_logs(limit.unwrap_or(100))
}

/// 获取日志目录路径
#[tauri::command]
pub fn get_log_dir(log_manager: State<'_, LogManager>) -> String {
    log_manager.get_log_dir().to_string_lossy().to_string()
}

/// 清空所有日志
#[tauri::command]
pub fn clear_logs(log_manager: State<'_, LogManager>) -> Result<(), String> {
    log_manager.clear_logs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    #[test]
    fn batch_command_deserializes_entries_and_writes_them() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        let app = mock_builder()
            .manage(LogManager::for_test(path.clone()))
            .invoke_handler(tauri::generate_handler![write_error_logs])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let entries = json!([
            { "type": "mqtt", "message": "first", "details": null, "timestamp": "2026-01-01" },
            { "type": "script", "message": "second", "details": "{\"aggregation\":{\"count\":3}}", "timestamp": "2026-01-02" }
        ]);
        let decoded: Vec<LogEntry> = serde_json::from_value(entries.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), entries);
        for entries in [entries, json!([])] {
            let response = get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "write_error_logs".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({ "entries": entries })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            assert!(response.is_ok(), "{:?}", response);
        }
        let manager = app.state::<LogManager>();
        let lines = manager.get_recent_logs(10).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "[2026-01-01] [MQTT] first");
        assert!(lines[1].contains("\"count\":3"));
        std::fs::remove_dir_all(path).unwrap();
        let response = get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "write_error_logs".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({ "entries": [
                    { "type": "mqtt", "message": "retry", "details": null, "timestamp": "2026-01-03" }
                ] })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        assert!(response
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("Failed to open log file"));
    }
}
