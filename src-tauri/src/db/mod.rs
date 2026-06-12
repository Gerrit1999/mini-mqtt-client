pub mod models;

use models::{
    CommandTemplate, CreateEnvVariableRequest, CreateScriptRequest, CreateTemplateRequest,
    EnvVariable, MessageCleanupResult, MessageHistory, MqttServer, Script, Subscription,
    UpdateEnvVariableRequest, UpdateScriptRequest, UpdateSubscriptionRequest, UpdateTemplateRequest,
};
use parking_lot::RwLock;
use rusqlite::{params, Connection, OpenFlags};
use serde::de::DeserializeOwned;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// `CommandTemplate.server_id` for templates visible on every connection (not a real broker id).
const GLOBAL_TEMPLATE_SERVER_ID: i64 = 0;
pub const DEFAULT_MESSAGE_LIMIT: usize = 1000;
pub const MIN_MESSAGE_LIMIT: usize = 100;
pub const MAX_MESSAGE_LIMIT: usize = 10000;
pub const DEFAULT_MQTT_PACKET_SIZE_LIMIT_KB: usize = 1024;
pub const MIN_MQTT_PACKET_SIZE_LIMIT_KB: usize = 10;
pub const MAX_MQTT_PACKET_SIZE_LIMIT_KB: usize = 102400;
pub const DEFAULT_MESSAGE_RETENTION_DAYS: u32 = 30;
pub const MIN_MESSAGE_RETENTION_DAYS: u32 = 1;
pub const MAX_MESSAGE_RETENTION_DAYS: u32 = 3650;
pub const DEFAULT_MESSAGE_RETENTION_COUNT: usize = 100000;
pub const MIN_MESSAGE_RETENTION_COUNT: usize = 1000;
pub const MAX_MESSAGE_RETENTION_COUNT: usize = 10_000_000;

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct AppData {
    pub servers: Vec<MqttServer>,
    pub subscriptions: Vec<Subscription>,
    #[serde(default, skip_serializing)]
    pub messages: Vec<MessageHistory>,
    #[serde(default)]
    pub templates: Vec<CommandTemplate>,
    #[serde(default)]
    pub scripts: Vec<Script>,
    #[serde(default)]
    pub env_variables: Vec<EnvVariable>,
    #[serde(default)]
    next_server_id: i64,
    #[serde(default)]
    next_subscription_id: i64,
    #[serde(default)]
    next_message_id: i64,
    #[serde(default)]
    next_template_id: i64,
    #[serde(default)]
    next_script_id: i64,
    #[serde(default)]
    next_env_variable_id: i64,
}

/// 应用配置（用于存储自定义数据路径等）
#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub data_path: Option<String>,
    #[serde(default)]
    pub message_limit: Option<usize>,
    #[serde(default)]
    pub mqtt_packet_size_limit_kb: Option<usize>,
    #[serde(default)]
    pub message_retention_days: Option<u32>,
    #[serde(default)]
    pub message_retention_count: Option<usize>,
}

pub struct Storage {
    data: RwLock<AppData>,
    config: RwLock<AppConfig>,
    config_path: PathBuf,
    file_path: PathBuf,
    message_db_path: PathBuf,
}

impl Storage {
    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;

        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

        let config_path = app_dir.join("config.yaml");
        let config = load_yaml_or_backup::<AppConfig>(&config_path)?;

        let file_path = if let Some(custom_path) = &config.data_path {
            let custom_path = PathBuf::from(custom_path);
            if custom_path.exists() || custom_path.parent().map(|p| p.exists()).unwrap_or(false) {
                custom_path
            } else {
                app_dir.join("data.yaml")
            }
        } else {
            app_dir.join("data.yaml")
        };

        let mut data = load_yaml_or_backup::<AppData>(&file_path)?;
        let legacy_messages = data.messages.clone();
        let message_db_path = message_db_path(&file_path);
        initialize_message_db(&message_db_path)?;
        migrate_legacy_messages(&legacy_messages, &message_db_path)?;
        if !legacy_messages.is_empty() {
            data.messages.clear();
        }

        let storage = Self {
            data: RwLock::new(data),
            config: RwLock::new(config),
            config_path,
            file_path,
            message_db_path,
        };
        storage.cleanup_message_history(false)?;

        Ok(storage)
    }

    /// 获取当前数据文件路径
    pub fn get_file_path(&self) -> &PathBuf {
        &self.file_path
    }

    pub fn get_message_db_path(&self) -> &PathBuf {
        &self.message_db_path
    }

    pub fn get_message_limit(&self) -> usize {
        sanitize_message_limit(self.config.read().message_limit)
    }

    pub fn set_message_limit(&self, limit: usize) -> Result<(), String> {
        let mut config = self.config.write();
        config.message_limit = Some(sanitize_message_limit(Some(limit)));
        drop(config);
        self.save_config()
    }

    pub fn get_mqtt_packet_size_limit_kb(&self) -> usize {
        sanitize_mqtt_packet_size_limit_kb(self.config.read().mqtt_packet_size_limit_kb)
    }

    pub fn get_mqtt_packet_size_limit_bytes(&self) -> usize {
        self.get_mqtt_packet_size_limit_kb() * 1024
    }

    pub fn set_mqtt_packet_size_limit_kb(&self, limit: usize) -> Result<(), String> {
        let mut config = self.config.write();
        config.mqtt_packet_size_limit_kb = Some(sanitize_mqtt_packet_size_limit_kb(Some(limit)));
        drop(config);
        self.save_config()
    }

    pub fn get_message_retention_days(&self) -> u32 {
        sanitize_message_retention_days(self.config.read().message_retention_days)
    }

    pub fn get_message_retention_count(&self) -> usize {
        sanitize_message_retention_count(self.config.read().message_retention_count)
    }

    pub fn set_message_cleanup_policy(
        &self,
        retention_days: u32,
        retention_count: usize,
    ) -> Result<(), String> {
        let mut config = self.config.write();
        config.message_retention_days = Some(sanitize_message_retention_days(Some(retention_days)));
        config.message_retention_count =
            Some(sanitize_message_retention_count(Some(retention_count)));
        drop(config);
        self.save_config()
    }

    pub fn set_data_path(&self, path: String) -> Result<(), String> {
        let mut config = self.config.write();
        config.data_path = Some(path);
        drop(config);
        self.save_config()
    }

    fn open_message_db(&self) -> Result<Connection, String> {
        Connection::open_with_flags(
            &self.message_db_path,
            OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|e| e.to_string())
    }

    fn delete_messages_by_server(&self, server_id: i64) -> Result<(), String> {
        let conn = self.open_message_db()?;
        conn.execute("DELETE FROM message_history WHERE server_id = ?", params![server_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn clear_messages_by_server(&self, server_id: i64) -> Result<(), String> {
        self.delete_messages_by_server(server_id)
    }

    pub fn cleanup_message_history(&self, vacuum: bool) -> Result<MessageCleanupResult, String> {
        let conn = self.open_message_db()?;
        let cutoff = chrono::Utc::now()
            - chrono::Duration::days(self.get_message_retention_days() as i64);
        let deleted_by_age = conn
            .execute(
                "DELETE FROM message_history WHERE created_at < ?",
                params![cutoff.to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;

        let retention_count = self.get_message_retention_count();
        let deleted_by_count = conn
            .execute(
                r#"
                DELETE FROM message_history
                WHERE id IN (
                    SELECT id
                    FROM (
                        SELECT
                            id,
                            ROW_NUMBER() OVER (
                                PARTITION BY server_id
                                ORDER BY created_at DESC, id DESC
                            ) AS row_num
                        FROM message_history
                    )
                    WHERE row_num > ?
                )
                "#,
                params![retention_count as i64],
            )
            .map_err(|e| e.to_string())?;

        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;

        if vacuum {
            conn.execute_batch("VACUUM;")
                .map_err(|e| e.to_string())?;
        }

        Ok(MessageCleanupResult {
            deleted_by_age,
            deleted_by_count,
            vacuumed: vacuum,
        })
    }

    fn save(&self) -> Result<(), String> {
        let data = self.data.read();
        let content = serde_yaml::to_string(&*data).map_err(|e| e.to_string())?;
        write_yaml_file_with_backup::<AppData>(&self.file_path, content.as_bytes())
    }

    fn save_config(&self) -> Result<(), String> {
        let config = self.config.read();
        let content = serde_yaml::to_string(&*config).map_err(|e| e.to_string())?;
        write_yaml_file_with_backup::<AppConfig>(&self.config_path, content.as_bytes())
    }

    // ===== Server 操作 =====
    pub fn get_servers(&self) -> Vec<MqttServer> {
        let data = self.data.read();
        data.servers.clone()
    }

    pub fn get_server(&self, id: i64) -> Option<MqttServer> {
        let data = self.data.read();
        data.servers.iter().find(|s| s.id == Some(id)).cloned()
    }

    pub fn create_server(&self, mut server: MqttServer) -> Result<i64, String> {
        let mut data = self.data.write();
        data.next_server_id += 1;
        let id = data.next_server_id;
        server.id = Some(id);
        server.created_at = Some(chrono::Utc::now().to_rfc3339());
        server.updated_at = server.created_at.clone();
        data.servers.push(server);
        drop(data);
        self.save()?;
        Ok(id)
    }

    pub fn update_server(&self, server: MqttServer) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(existing) = data.servers.iter_mut().find(|s| s.id == server.id) {
            *existing = server;
            existing.updated_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    pub fn delete_server(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        data.servers.retain(|s| s.id != Some(id));
        // 同时删除相关订阅、消息、模板、脚本和环境变量
        data.subscriptions.retain(|s| s.server_id != id);
        data.templates.retain(|t| t.server_id != id);
        data.scripts.retain(|s| s.server_id != id);
        data.env_variables.retain(|e| e.server_id != id);
        drop(data);
        self.delete_messages_by_server(id)?;
        self.save()
    }

    // ===== 订阅操作 =====
    pub fn get_subscriptions(&self, server_id: i64) -> Vec<Subscription> {
        let data = self.data.read();
        data.subscriptions
            .iter()
            .filter(|s| s.server_id == server_id)
            .cloned()
            .collect()
    }

    pub fn create_subscription(&self, mut sub: Subscription) -> Result<Subscription, String> {
        let mut data = self.data.write();
        data.next_subscription_id += 1;
        sub.id = Some(data.next_subscription_id);
        sub.created_at = Some(chrono::Utc::now().to_rfc3339());
        let result = sub.clone();
        data.subscriptions.push(sub);
        drop(data);
        self.save()?;
        Ok(result)
    }

    pub fn update_subscription_status(&self, id: i64, is_active: bool) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(sub) = data.subscriptions.iter_mut().find(|s| s.id == Some(id)) {
            sub.is_active = is_active;
        }
        drop(data);
        self.save()
    }

    pub fn update_subscription(
        &self,
        req: UpdateSubscriptionRequest,
    ) -> Result<Subscription, String> {
        let mut data = self.data.write();
        if let Some(sub) = data.subscriptions.iter_mut().find(|s| s.id == Some(req.id)) {
            if let Some(topic) = req.topic {
                sub.topic = topic;
            }
            if let Some(qos) = req.qos {
                sub.qos = qos;
            }
            // color 可以设置为 None（清除颜色）
            sub.color = req.color;
            let result = sub.clone();
            drop(data);
            self.save()?;
            Ok(result)
        } else {
            Err("Subscription not found".to_string())
        }
    }

    pub fn delete_subscription(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        data.subscriptions.retain(|s| s.id != Some(id));
        drop(data);
        self.save()
    }

    // ===== 消息操作 =====
    pub fn get_messages(&self, server_id: i64, limit: usize, offset: usize) -> Vec<MessageHistory> {
        let conn = match self.open_message_db() {
            Ok(conn) => conn,
            Err(_) => return Vec::new(),
        };

        let mut stmt = match conn.prepare(
            r#"
            SELECT id, server_id, direction, topic, payload, payload_format, qos, retain, created_at
            FROM message_history
            WHERE server_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
            "#,
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };

        let rows = match stmt.query_map(params![server_id, limit as i64, offset as i64], |row| {
            Ok(MessageHistory {
                id: row.get(0)?,
                server_id: row.get(1)?,
                direction: row.get(2)?,
                topic: row.get(3)?,
                payload: row.get(4)?,
                payload_format: row.get(5)?,
                qos: row.get(6)?,
                retain: row.get::<_, i64>(7)? != 0,
                created_at: row.get(8)?,
            })
        }) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };

        rows.filter_map(Result::ok).collect()
    }

    pub fn create_message(&self, mut msg: MessageHistory) -> Result<MessageHistory, String> {
        let conn = self.open_message_db()?;
        if msg.created_at.is_none() {
            msg.created_at = Some(chrono::Utc::now().to_rfc3339());
        }

        conn.execute(
            r#"
            INSERT INTO message_history (
                server_id, direction, topic, payload, payload_format, qos, retain, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                msg.server_id,
                msg.direction,
                msg.topic,
                msg.payload,
                msg.payload_format,
                msg.qos,
                if msg.retain { 1 } else { 0 },
                msg.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;

        msg.id = Some(conn.last_insert_rowid());
        Ok(msg)
    }

    pub fn clear_messages(&self, server_id: i64) -> Result<(), String> {
        self.clear_messages_by_server(server_id)
    }

    // ===== 模板操作 =====
    pub fn get_templates(&self, server_id: i64) -> Vec<CommandTemplate> {
        let data = self.data.read();
        data.templates
            .iter()
            .filter(|t| t.server_id == server_id || t.server_id == GLOBAL_TEMPLATE_SERVER_ID)
            .cloned()
            .collect()
    }

    pub fn get_template(&self, id: i64) -> Option<CommandTemplate> {
        let data = self.data.read();
        data.templates.iter().find(|t| t.id == Some(id)).cloned()
    }

    pub fn create_template(&self, req: CreateTemplateRequest) -> Result<i64, String> {
        let mut data = self.data.write();
        data.next_template_id += 1;
        let id = data.next_template_id;
        let now = chrono::Utc::now().to_rfc3339();

        let template = CommandTemplate {
            id: Some(id),
            server_id: req.server_id,
            name: req.name,
            topic: req.topic,
            payload: req.payload,
            payload_type: req.payload_type,
            qos: req.qos,
            retain: req.retain,
            description: req.description,
            category: req.category,
            use_count: 0,
            last_used_at: None,
            created_at: Some(now.clone()),
            updated_at: Some(now),
        };

        data.templates.push(template);
        drop(data);
        self.save()?;
        Ok(id)
    }

    pub fn update_template(&self, req: UpdateTemplateRequest) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(template) = data.templates.iter_mut().find(|t| t.id == Some(req.id)) {
            if let Some(name) = req.name {
                template.name = name;
            }
            if let Some(topic) = req.topic {
                template.topic = topic;
            }
            if let Some(payload) = req.payload {
                template.payload = payload;
            }
            if let Some(payload_type) = req.payload_type {
                template.payload_type = payload_type;
            }
            if let Some(qos) = req.qos {
                template.qos = qos;
            }
            if let Some(retain) = req.retain {
                template.retain = retain;
            }
            if let Some(description) = req.description {
                template.description = Some(description);
            }
            if let Some(category) = req.category {
                template.category = Some(category);
            }
            template.updated_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    pub fn delete_template(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        data.templates.retain(|t| t.id != Some(id));
        drop(data);
        self.save()
    }

    pub fn increment_template_use_count(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(template) = data.templates.iter_mut().find(|t| t.id == Some(id)) {
            template.use_count += 1;
            template.last_used_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    pub fn get_template_categories(&self, server_id: i64) -> Vec<String> {
        let data = self.data.read();
        let mut categories: Vec<String> = data
            .templates
            .iter()
            .filter(|t| t.server_id == server_id || t.server_id == GLOBAL_TEMPLATE_SERVER_ID)
            .filter_map(|t| t.category.clone())
            .collect();
        categories.sort();
        categories.dedup();
        categories
    }

    // ===== 脚本操作 =====
    pub fn get_scripts(&self, server_id: i64) -> Vec<Script> {
        let data = self.data.read();
        data.scripts
            .iter()
            .filter(|s| s.server_id == server_id)
            .cloned()
            .collect()
    }

    pub fn get_script(&self, id: i64) -> Option<Script> {
        let data = self.data.read();
        data.scripts.iter().find(|s| s.id == Some(id)).cloned()
    }

    pub fn get_enabled_scripts(&self, server_id: i64, script_type: &str) -> Vec<Script> {
        let data = self.data.read();
        data.scripts
            .iter()
            .filter(|s| s.server_id == server_id && s.enabled && s.script_type == script_type)
            .cloned()
            .collect()
    }

    pub fn create_script(&self, req: CreateScriptRequest) -> Result<i64, String> {
        let mut data = self.data.write();
        data.next_script_id += 1;
        let id = data.next_script_id;
        let now = chrono::Utc::now().to_rfc3339();

        let script = Script {
            id: Some(id),
            server_id: req.server_id,
            name: req.name,
            script_type: req.script_type,
            code: req.code,
            enabled: req.enabled,
            description: req.description,
            created_at: Some(now.clone()),
            updated_at: Some(now),
        };

        data.scripts.push(script);
        drop(data);
        self.save()?;
        Ok(id)
    }

    pub fn update_script(&self, req: UpdateScriptRequest) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(script) = data.scripts.iter_mut().find(|s| s.id == Some(req.id)) {
            if let Some(name) = req.name {
                script.name = name;
            }
            if let Some(code) = req.code {
                script.code = code;
            }
            if let Some(enabled) = req.enabled {
                script.enabled = enabled;
            }
            if let Some(description) = req.description {
                script.description = Some(description);
            }
            script.updated_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    pub fn delete_script(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        data.scripts.retain(|s| s.id != Some(id));
        drop(data);
        self.save()
    }

    pub fn toggle_script(&self, id: i64, enabled: bool) -> Result<(), String> {
        let mut data = self.data.write();
        if let Some(script) = data.scripts.iter_mut().find(|s| s.id == Some(id)) {
            script.enabled = enabled;
            script.updated_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    // ===== 环境变量操作 =====
    pub fn get_env_variables(&self, server_id: i64) -> Vec<EnvVariable> {
        let data = self.data.read();
        data.env_variables
            .iter()
            .filter(|e| e.server_id == server_id)
            .cloned()
            .collect()
    }

    pub fn get_env_variable(&self, id: i64) -> Option<EnvVariable> {
        let data = self.data.read();
        data.env_variables
            .iter()
            .find(|e| e.id == Some(id))
            .cloned()
    }

    pub fn create_env_variable(&self, req: CreateEnvVariableRequest) -> Result<i64, String> {
        let mut data = self.data.write();

        // 检查变量名是否重复
        let exists = data
            .env_variables
            .iter()
            .any(|e| e.server_id == req.server_id && e.name == req.name);
        if exists {
            return Err("Variable name already exists".to_string());
        }

        data.next_env_variable_id += 1;
        let id = data.next_env_variable_id;
        let now = chrono::Utc::now().to_rfc3339();

        let env_var = EnvVariable {
            id: Some(id),
            server_id: req.server_id,
            name: req.name,
            value: req.value,
            description: req.description,
            created_at: Some(now.clone()),
            updated_at: Some(now),
        };

        data.env_variables.push(env_var);
        drop(data);
        self.save()?;
        Ok(id)
    }

    pub fn update_env_variable(&self, req: UpdateEnvVariableRequest) -> Result<(), String> {
        let mut data = self.data.write();

        // 如果要更新名称，检查是否与其他变量重复
        if let Some(new_name) = &req.name {
            let current = data.env_variables.iter().find(|e| e.id == Some(req.id));
            if let Some(current) = current {
                let exists = data.env_variables.iter().any(|e| {
                    e.server_id == current.server_id && e.name == *new_name && e.id != Some(req.id)
                });
                if exists {
                    return Err("Variable name already exists".to_string());
                }
            }
        }

        if let Some(env_var) = data.env_variables.iter_mut().find(|e| e.id == Some(req.id)) {
            if let Some(name) = req.name {
                env_var.name = name;
            }
            if let Some(value) = req.value {
                env_var.value = value;
            }
            if let Some(description) = req.description {
                env_var.description = Some(description);
            }
            env_var.updated_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(data);
        self.save()
    }

    pub fn delete_env_variable(&self, id: i64) -> Result<(), String> {
        let mut data = self.data.write();
        data.env_variables.retain(|e| e.id != Some(id));
        drop(data);
        self.save()
    }
}

fn message_db_path(data_file_path: &Path) -> PathBuf {
    if data_file_path.extension().and_then(|ext| ext.to_str()) == Some("yaml") {
        data_file_path.with_file_name("messages.sqlite")
    } else {
        data_file_path.with_extension("messages.sqlite")
    }
}

fn initialize_message_db(message_db_path: &Path) -> Result<(), String> {
    if let Some(parent) = message_db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let conn = Connection::open(message_db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS message_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL,
          direction TEXT NOT NULL,
          topic TEXT NOT NULL,
          payload TEXT,
          payload_format TEXT,
          qos INTEGER NOT NULL,
          retain INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_message_history_server_created_at
          ON message_history(server_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_message_history_server_topic_created_at
          ON message_history(server_id, topic, created_at DESC, id DESC);
        "#,
    )
    .map_err(|e| e.to_string())
}

fn migrate_legacy_messages(
    legacy_messages: &[MessageHistory],
    message_db_path: &Path,
) -> Result<(), String> {
    if legacy_messages.is_empty() {
        return Ok(());
    }

    let mut conn = Connection::open(message_db_path).map_err(|e| e.to_string())?;
    let has_existing_messages: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM message_history LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_existing_messages != 0 {
        return Ok(());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO message_history (
                    server_id, direction, topic, payload, payload_format, qos, retain, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
            )
            .map_err(|e| e.to_string())?;

        for msg in legacy_messages {
            stmt.execute(params![
                msg.server_id,
                msg.direction,
                msg.topic,
                msg.payload,
                msg.payload_format,
                msg.qos,
                if msg.retain { 1 } else { 0 },
                msg.created_at,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn sanitize_message_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .clamp(MIN_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)
}

fn sanitize_mqtt_packet_size_limit_kb(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_MQTT_PACKET_SIZE_LIMIT_KB)
        .clamp(MIN_MQTT_PACKET_SIZE_LIMIT_KB, MAX_MQTT_PACKET_SIZE_LIMIT_KB)
}

fn sanitize_message_retention_days(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_MESSAGE_RETENTION_DAYS)
        .clamp(MIN_MESSAGE_RETENTION_DAYS, MAX_MESSAGE_RETENTION_DAYS)
}

fn sanitize_message_retention_count(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_MESSAGE_RETENTION_COUNT)
        .clamp(MIN_MESSAGE_RETENTION_COUNT, MAX_MESSAGE_RETENTION_COUNT)
}

fn load_yaml_or_backup<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    if !path.exists() {
        if let Some((loaded_path, value)) = load_first_available_backup(path) {
            return value.map_err(|backup_error| {
                format!(
                    "{} is missing and backup {} could not be loaded: {}",
                    path.display(),
                    loaded_path.display(),
                    backup_error
                )
            });
        }
        return Ok(T::default());
    }

    match read_yaml_file(path) {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            if let Some((loaded_path, value)) = load_first_available_backup(path) {
                return value.map_err(|backup_error| {
                    format!(
                        "{} could not be loaded: {}; backup {} also failed: {}",
                        path.display(),
                        primary_error,
                        loaded_path.display(),
                        backup_error
                    )
                });
            }

            Err(primary_error)
        }
    }
}

fn load_first_available_backup<T>(path: &Path) -> Option<(PathBuf, Result<T, String>)>
where
    T: DeserializeOwned,
{
    for fallback_path in [replacing_path(path), backup_path(path)] {
        if fallback_path.exists() {
            return Some((fallback_path.clone(), read_yaml_file(&fallback_path)));
        }
    }
    None
}

fn read_yaml_file<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn write_yaml_file_with_backup<T>(path: &Path, content: &[u8]) -> Result<(), String>
where
    T: DeserializeOwned,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    let temp_path = temp_path(path);
    let backup_path = backup_path(path);
    let replacing_path = replacing_path(path);

    if temp_path.exists() {
        fs::remove_file(&temp_path)
            .map_err(|e| format!("Failed to remove stale {}: {}", temp_path.display(), e))?;
    }

    {
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("Failed to create {}: {}", temp_path.display(), e))?;

        temp_file
            .write_all(content)
            .map_err(|e| format!("Failed to write {}: {}", temp_path.display(), e))?;
        temp_file
            .sync_all()
            .map_err(|e| format!("Failed to flush {}: {}", temp_path.display(), e))?;
    }

    let replaced_current_file = path.exists();
    let should_backup_current = replaced_current_file && read_yaml_file::<T>(path).is_ok();

    if replaced_current_file {
        if replacing_path.exists() {
            fs::remove_file(&replacing_path).map_err(|e| {
                format!("Failed to remove stale {}: {}", replacing_path.display(), e)
            })?;
        }

        fs::rename(path, &replacing_path).map_err(|e| {
            format!(
                "Failed to move {} before replacement {}: {}",
                path.display(),
                replacing_path.display(),
                e
            )
        })?;
    }

    if let Err(replace_error) = fs::rename(&temp_path, path) {
        if replacing_path.exists() && !path.exists() {
            let _ = fs::rename(&replacing_path, path);
        }
        let _ = fs::remove_file(&temp_path);

        return Err(format!(
            "Failed to replace {} with {}: {}",
            path.display(),
            temp_path.display(),
            replace_error
        ));
    }

    if replaced_current_file && replacing_path.exists() {
        if should_backup_current {
            if backup_path.exists() {
                fs::remove_file(&backup_path).map_err(|e| {
                    format!(
                        "Failed to remove old backup {}: {}",
                        backup_path.display(),
                        e
                    )
                })?;
            }

            fs::rename(&replacing_path, &backup_path).map_err(|e| {
                format!(
                    "Failed to move {} to backup {}: {}",
                    replacing_path.display(),
                    backup_path.display(),
                    e
                )
            })?;
        } else {
            fs::remove_file(&replacing_path).map_err(|e| {
                format!(
                    "Failed to remove invalid replaced file {}: {}",
                    replacing_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    sibling_path_with_suffix(path, "tmp")
}

fn replacing_path(path: &Path) -> PathBuf {
    sibling_path_with_suffix(path, "old")
}

fn backup_path(path: &Path) -> PathBuf {
    sibling_path_with_suffix(path, "bak")
}

fn sibling_path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "data".into());

    path.with_file_name(format!("{}.{}", file_name, suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mini-mqtt-client-{}-{}-{}",
            name,
            std::process::id(),
            timestamp
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_file_with_backup_replaces_file_and_keeps_previous_copy() {
        let dir = test_dir("write-backup");
        let path = dir.join("data.yaml");

        fs::write(&path, b"servers: []\n").unwrap();
        write_yaml_file_with_backup::<serde_yaml::Value>(&path, b"servers:\n- name: local\n")
            .unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "servers:\n- name: local\n"
        );
        assert_eq!(
            fs::read_to_string(backup_path(&path)).unwrap(),
            "servers: []\n"
        );
        assert!(!temp_path(&path).exists());
        assert!(!replacing_path(&path).exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_yaml_or_backup_recovers_when_primary_is_corrupt() {
        let dir = test_dir("load-backup");
        let path = dir.join("data.yaml");
        let backup = backup_path(&path);

        fs::write(&path, b"\0\0\0\0").unwrap();
        fs::write(
            backup,
            b"servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables: []\n",
        )
        .unwrap();

        let data = load_yaml_or_backup::<AppData>(&path).unwrap();

        assert!(data.servers.is_empty());
        assert!(data.scripts.is_empty());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_yaml_or_backup_prefers_replaced_file_before_backup() {
        let dir = test_dir("load-old");
        let path = dir.join("data.yaml");
        let replaced = replacing_path(&path);
        let backup = backup_path(&path);

        fs::write(
            replaced,
            b"servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables:\n- id: 1\n  server_id: 1\n  name: from_old\n  value: newer\n  description: null\n  created_at: null\n  updated_at: null\n",
        )
        .unwrap();
        fs::write(
            backup,
            b"servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables: []\n",
        )
        .unwrap();

        let data = load_yaml_or_backup::<AppData>(&path).unwrap();

        assert_eq!(data.env_variables.len(), 1);
        assert_eq!(data.env_variables[0].name, "from_old");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_file_with_backup_preserves_existing_backup_when_current_file_is_corrupt() {
        let dir = test_dir("preserve-backup");
        let path = dir.join("data.yaml");
        let backup = backup_path(&path);

        fs::write(&path, b"\0\0\0").unwrap();
        fs::write(&backup, b"servers: []\n").unwrap();

        write_yaml_file_with_backup::<AppData>(
            &path,
            b"servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables: []\n",
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables: []\n"
        );
        assert_eq!(fs::read_to_string(&backup).unwrap(), "servers: []\n");
        assert!(!replacing_path(&path).exists());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_file_with_backup_keeps_replaced_file_when_primary_is_missing() {
        let dir = test_dir("keep-old");
        let path = dir.join("data.yaml");
        let replaced = replacing_path(&path);

        fs::write(&replaced, b"servers: []\n").unwrap();

        write_yaml_file_with_backup::<AppData>(
            &path,
            b"servers: []\nsubscriptions: []\nmessages: []\ntemplates: []\nscripts: []\nenv_variables: []\n",
        )
        .unwrap();

        assert!(path.exists());
        assert_eq!(fs::read_to_string(replaced).unwrap(), "servers: []\n");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_yaml_or_backup_fails_when_primary_and_backup_are_corrupt() {
        let dir = test_dir("load-fail");
        let path = dir.join("data.yaml");
        let backup = backup_path(&path);

        fs::write(&path, b"\0\0").unwrap();
        fs::write(backup, b"\0\0").unwrap();

        let error = load_yaml_or_backup::<AppData>(&path).unwrap_err();

        assert!(error.contains("could not be loaded"));
        assert!(error.contains("backup"));

        fs::remove_dir_all(dir).unwrap();
    }
}
