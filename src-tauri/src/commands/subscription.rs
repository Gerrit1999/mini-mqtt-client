use crate::db::models::{Subscription, UpdateSubscriptionRequest};
use crate::db::Storage;
use crate::mqtt::MqttManager;
use tauri::State;

fn subscribe_in_background(mqtt_manager: &MqttManager, server_id: i64, topic: String, qos: u8) {
    let mqtt_manager = mqtt_manager.clone();
    tauri::async_runtime::spawn(async move {
        let _ = mqtt_manager.subscribe(server_id, topic, qos).await;
    });
}

fn unsubscribe_in_background(mqtt_manager: &MqttManager, server_id: i64, topic: String) {
    let mqtt_manager = mqtt_manager.clone();
    tauri::async_runtime::spawn(async move {
        let _ = mqtt_manager.unsubscribe(server_id, topic).await;
    });
}

#[tauri::command]
pub async fn add_subscription(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    server_id: i64,
    topic: String,
    qos: i32,
) -> Result<Subscription, String> {
    // 创建订阅
    let sub = Subscription {
        id: None,
        server_id,
        topic: topic.clone(),
        qos,
        is_active: true,
        color: None,
        created_at: None,
    };

    let subscription = storage.create_subscription(sub)?;

    // 如果已连接，则订阅主题
    if mqtt_manager.is_connected(server_id) {
        // 配置已经保存；Broker 失败通过运行状态事件报告，不能回滚配置意图。
        subscribe_in_background(mqtt_manager.inner(), server_id, topic, qos as u8);
    }

    Ok(subscription)
}

#[tauri::command]
pub async fn remove_subscription(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    subscription_id: i64,
    server_id: i64,
    topic: String,
) -> Result<(), String> {
    // 如果已连接，则取消订阅
    if mqtt_manager.is_connected(server_id) {
        mqtt_manager
            .unsubscribe(server_id, topic)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 从存储删除
    storage.delete_subscription(subscription_id)
}

#[tauri::command]
pub async fn get_subscriptions(
    storage: State<'_, Storage>,
    server_id: i64,
) -> Result<Vec<Subscription>, String> {
    Ok(storage.get_subscriptions(server_id))
}

#[tauri::command]
pub async fn toggle_subscription(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    subscription_id: i64,
    server_id: i64,
    topic: String,
    qos: i32,
    is_active: bool,
) -> Result<(), String> {
    // 更新存储状态
    storage.update_subscription_status(subscription_id, is_active)?;

    // 执行订阅/取消订阅操作
    if mqtt_manager.is_connected(server_id) {
        if is_active {
            subscribe_in_background(mqtt_manager.inner(), server_id, topic, qos as u8);
        } else {
            unsubscribe_in_background(mqtt_manager.inner(), server_id, topic);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_subscription(
    storage: State<'_, Storage>,
    mqtt_manager: State<'_, MqttManager>,
    server_id: i64,
    old_topic: String,
    request: UpdateSubscriptionRequest,
) -> Result<Subscription, String> {
    let existing = storage
        .get_subscriptions(server_id)
        .into_iter()
        .find(|subscription| subscription.id == Some(request.id))
        .ok_or("Subscription not found")?;
    if old_topic != existing.topic {
        return Err("Subscription changed; reload before editing".to_string());
    }
    let next_topic = request
        .topic
        .clone()
        .unwrap_or_else(|| existing.topic.clone());
    let topic_changed = next_topic != existing.topic;
    let qos_changed = request.qos.is_some_and(|qos| qos != existing.qos);
    let connected = mqtt_manager.is_connected(server_id) && existing.is_active;

    if connected && topic_changed {
        mqtt_manager
            .unsubscribe(server_id, old_topic)
            .await
            .map_err(|error| error.to_string())?;
    }

    let subscription = match storage.update_subscription(request) {
        Ok(subscription) => subscription,
        Err(error) => {
            if connected && topic_changed {
                let _ = mqtt_manager
                    .subscribe(server_id, existing.topic, existing.qos as u8)
                    .await;
            }
            return Err(error);
        }
    };

    if connected && (topic_changed || qos_changed) {
        subscribe_in_background(
            mqtt_manager.inner(),
            server_id,
            subscription.topic.clone(),
            subscription.qos as u8,
        );
    }

    Ok(subscription)
}
