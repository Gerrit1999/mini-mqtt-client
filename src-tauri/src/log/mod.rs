use chrono::Local;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub r#type: String,
    pub message: String,
    pub details: Option<String>,
    pub timestamp: String,
}

/// 日志管理器
pub struct LogManager {
    log_dir: PathBuf,
    max_log_files: usize,
    max_file_size: u64, // bytes
    write_lock: Mutex<()>,
}

impl LogManager {
    #[cfg(test)]
    pub(crate) fn for_test(log_dir: PathBuf) -> Self {
        Self {
            log_dir,
            max_log_files: 10,
            max_file_size: 5_000_000,
            write_lock: Mutex::new(()),
        }
    }

    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;

        let log_dir = app_dir.join("logs");
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

        Ok(Self {
            log_dir,
            max_log_files: 10,        // 最多保留 10 个日志文件
            max_file_size: 5_000_000, // 每个文件最大 5MB
            write_lock: Mutex::new(()),
        })
    }

    /// 获取当前日志文件路径
    fn get_current_log_file(&self) -> PathBuf {
        let today = Local::now().format("%Y-%m-%d").to_string();
        self.log_dir.join(format!("error-{}.log", today))
    }

    /// 写入日志条目
    pub fn write_log(&self, entry: &LogEntry) -> Result<(), String> {
        self.write_logs(std::slice::from_ref(entry))
    }

    /// A batch rotates, opens, writes and cleans up once. Serialize writers so
    /// the legacy single-entry command and batch command cannot race rotation.
    pub fn write_logs(&self, entries: &[LogEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let _guard = self.write_lock.lock();
        let mut contents = String::new();
        for entry in entries {
            contents.push_str(&format!(
                "[{}] [{}] {}{}\n",
                entry.timestamp,
                entry.r#type.to_uppercase(),
                entry.message,
                entry
                    .details
                    .as_ref()
                    .map(|d| format!(" | Details: {}", d))
                    .unwrap_or_default()
            ));
        }
        let log_file = self.get_current_log_file();

        // 检查文件大小，如果超过限制则轮转
        if log_file.exists() {
            if let Ok(metadata) = fs::metadata(&log_file) {
                if metadata.len() > self.max_file_size {
                    self.rotate_log_file(&log_file)?;
                }
            }
        }

        // 打开或创建日志文件
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .map_err(|e| format!("Failed to open log file: {}", e))?;

        let original_len = file.metadata().map_err(|e| e.to_string())?.len();
        if let Err(error) = file.write_all(contents.as_bytes()) {
            // Remove a partial append before the frontend retries the batch.
            file.set_len(original_len)
                .map_err(|e| format!("Failed to write log: {}; rollback failed: {}", error, e))?;
            return Err(format!("Failed to write log: {}", error));
        }

        // 清理旧日志文件
        // The append has committed. A cleanup failure must not cause callers to
        // retry already-written occurrences.
        if let Err(error) = self.cleanup_old_logs() {
            eprintln!("Failed to clean up error logs: {}", error);
        }

        Ok(())
    }

    /// 轮转日志文件
    fn rotate_log_file(&self, log_file: &PathBuf) -> Result<(), String> {
        let timestamp = Local::now().format("%Y-%m-%d_%H%M%S").to_string();
        let rotated_name = log_file.with_extension(format!("{}.log", timestamp));
        fs::rename(log_file, rotated_name).map_err(|e| format!("Failed to rotate log file: {}", e))
    }

    /// 清理旧日志文件
    fn cleanup_old_logs(&self) -> Result<(), String> {
        let mut log_files: Vec<_> = fs::read_dir(&self.log_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .map(|ext| ext == "log")
                    .unwrap_or(false)
            })
            .collect();

        if log_files.len() <= self.max_log_files {
            return Ok(());
        }

        // 按修改时间排序
        log_files.sort_by_key(|entry| {
            entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });

        // 删除最旧的文件
        let to_delete = log_files.len() - self.max_log_files;
        for entry in log_files.into_iter().take(to_delete) {
            let _ = fs::remove_file(entry.path());
        }

        Ok(())
    }

    /// 获取日志目录路径
    pub fn get_log_dir(&self) -> &PathBuf {
        &self.log_dir
    }

    /// 读取最近的日志条目
    pub fn get_recent_logs(&self, limit: usize) -> Result<Vec<String>, String> {
        let log_file = self.get_current_log_file();

        if !log_file.exists() {
            return Ok(Vec::new());
        }

        let file = File::open(&log_file).map_err(|e| format!("Failed to read log file: {}", e))?;

        let reader = BufReader::new(file);
        let lines: Vec<String> = reader.lines().filter_map(|line| line.ok()).collect();

        // 返回最后 limit 行
        let start = if lines.len() > limit {
            lines.len() - limit
        } else {
            0
        };

        Ok(lines[start..].to_vec())
    }

    /// 清空所有日志
    pub fn clear_logs(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.log_dir).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry {
                if entry
                    .path()
                    .extension()
                    .map(|ext| ext == "log")
                    .unwrap_or(false)
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message: &str) -> LogEntry {
        LogEntry {
            r#type: "script".into(),
            message: message.into(),
            details: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn empty_batch_does_not_create_or_open_files() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let manager = LogManager::for_test(path.clone());
        manager.write_logs(&[]).unwrap();
        assert!(!path.exists());
        assert!(manager.write_logs(&[entry("failure")]).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn batch_and_single_writes_share_format_rotation_and_cleanup() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        let mut manager = LogManager::for_test(path.clone());
        manager.write_log(&entry("single")).unwrap();
        manager
            .write_logs(&[entry("first"), entry("second")])
            .unwrap();
        let lines = manager.get_recent_logs(10).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "[2026-01-01T00:00:00Z] [SCRIPT] single");
        assert!(lines[1].ends_with("first"));
        assert!(lines[2].ends_with("second"));

        manager.max_file_size = 1;
        manager.max_log_files = 1;
        manager
            .write_logs(&[entry("rotated first"), entry("rotated second")])
            .unwrap();
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
        assert_eq!(manager.get_recent_logs(10).unwrap().len(), 2);
        fs::remove_dir_all(path).unwrap();
    }
}
