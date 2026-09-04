# Issue #15: MQTT 发布确认生命周期调查

调查日期：2026-09-04
代码基线：`origin/main` (`432008ba95c081909771704ff3bd388135e6592d`)
Issue：<https://github.com/Gerrit1999/mini-mqtt-client/issues/15>

## 结论

当前发布返回值只表示请求已写入 rumqttc 的请求通道，不能表示 Broker 已确认。
推荐复用 issue #14 的订阅 tracker 思路，但发布 tracker 必须支持并发操作，并在
rumqttc event loop 的 `Outgoing::Publish(packet_id)` 事件中把 operation ID 与 packet ID
绑定。QoS 1 以 `PUBACK` 为终态，QoS 2 以 `PUBCOMP` 为终态，QoS 0 以
`Outgoing::Publish(0)` 为 `sent` 终态。

不要使用 Topic/Payload 关联 ACK，也不要把 `AsyncClient::publish().await` 当成 ACK。

## 当前行为

### Rust 发布链路

1. `publish_message` 解码 payload。
2. 调用 `MqttManager::publish`。
3. `ProtocolClient::publish` 调用 rumqttc `AsyncClient::publish().await`。
4. 调用返回后，立即把消息作为成功历史写入 SQLite。

相关位置：

- `src-tauri/src/commands/publish.rs:7-46`
- `src-tauri/src/mqtt/client.rs:191-209`
- `src-tauri/src/mqtt/client.rs:688-704`
- `src-tauri/src/commands/mqtt.rs:23-33`

rumqttc 0.25.1 的 `AsyncClient::publish` 只把 `Request::Publish` 发送到 channel，返回
`Result<(), ClientError>`；Publish 初始 packet ID 为 0。QoS 1/2 的 packet ID 是稍后在
event loop state 中分配的。

相关依赖源码：

- `src-tauri/Cargo.toml:28`
- `rumqttc-0.25.1/src/client.rs:68-89`
- `rumqttc-0.25.1/src/mqttbytes/v4/publish.rs:15-24`
- `rumqttc-0.25.1/src/state.rs:309-347`
- `rumqttc-0.25.1/src/v5/state.rs:472-525`

因此，当前 `publish_message` 在没有收到 PUBACK/PUBCOMP 时已经写入“成功历史”。

### Event loop

当前 `ProtocolEvent` 只映射连接、接收消息和订阅确认。以下发布事件都会进入
`ProtocolEvent::Other`：

- `Outgoing::Publish(packet_id)`
- MQTT 3.1.1 `Incoming::PubAck/PubRec/PubComp`
- MQTT 5.0 `Incoming::PubAck/PubRec/PubComp`

相关位置：

- `src-tauri/src/mqtt/client.rs:257-280`
- `src-tauri/src/mqtt/client.rs:283-405`
- `src-tauri/src/mqtt/client.rs:530-660`

### 前端和历史

手动发布调用链：

```text
PublishPanel.doPublishCore
  -> messageStore.publishMessage
  -> Tauri publish_message
  -> SQLite create_message
  -> mqttStore.addPublishMessage
```

相关位置：

- `src/components/mqtt/PublishPanel.vue:341-414`
- `src/stores/message.ts:93-123`

批量定时发布走另一条链路，直接调用 `mqttStore.publish` 和 `mqtt_publish`，不会写入
SQLite 历史：

- `src/components/mqtt/ScheduledPublishDialog.vue:493-577`
- `src/stores/mqtt.ts:424-458`

当前 `MqttMessage`、`MessageHistory`、`PublishPayload` 以及 SQLite 表都没有
operation ID、发布状态、packet ID 和错误原因：

- `src/types/mqtt.ts:57-72,124-145`
- `src-tauri/src/db/models.rs:68-96`
- `src-tauri/src/db/mod.rs:762-790`

`MessageList` 合并历史和实时消息时优先使用数据库 ID，其次使用 seq。即使后续增加
状态事件，如果不把 operation ID 作为首选 key，也会产生重复项：

- `src/components/mqtt/MessageList.vue:401-419`
- `src/components/mqtt/MessageList.vue:544-549`

## 已排除方案

### 1. 把 command 返回视为确认

不可行。rumqttc 的返回值只证明请求成功进入 channel，packet ID 尚未分配。

### 2. 用 Topic/Payload 匹配

不可行。相同 Topic/Payload 的并发发布无法区分，retain/QoS 相同也不能形成稳定标识。

### 3. 每个连接只允许一个待确认发布

正确但代价过高。它可以像当前订阅 gate 一样简化关联，但会让定时/批量发布在 ACK
延迟或丢失时完全串行，改变现有吞吐和间隔语义。可作为第一阶段保守实现，不建议作为
最终方案。

### 4. Fork rumqttc，让 publish 直接返回 packet ID

技术上最直接，但需要长期维护依赖补丁。当前 rumqttc 已提供足够的
`Outgoing::Publish` 和 ACK 事件，先不引入 fork。

## 推荐方案

### 1. 增加发布领域模型

建议新增 `src-tauri/src/mqtt/publish.rs`，定义：

```rust
enum PublishRuntimeStatus {
    Pending,
    Sent,
    Confirmed,
    Failed,
}

struct PublishStateEvent {
    operation_id: String,
    server_id: i64,
    qos: u8,
    status: PublishRuntimeStatus,
    packet_id: Option<u16>,
    error: Option<String>,
}

struct PublishOperationResult {
    operation_id: String,
    status: PublishRuntimeStatus,
    packet_id: Option<u16>,
}
```

状态语义：

| QoS | 状态转换 | 成功终态 |
| --- | --- | --- |
| 0 | `pending -> sent` | `Outgoing::Publish(0)` |
| 1 | `pending -> sent -> confirmed` | 匹配 packet ID 的 PUBACK |
| 2 | `pending -> sent -> confirmed` | 匹配 packet ID 的 PUBCOMP |

QoS 2 的 PUBREC/PUBREL 只是中间协议阶段，不能标记 confirmed。

MQTT 5.0 中 `Success` 和 `NoMatchingSubscribers` 是成功结果；其他 PUBACK/PUBREC
reason code 应进入 failed。PUBCOMP 只有 `Success` 是成功。

### 2. 使用 FIFO 建立 operation ID 到 packet ID 的绑定

每个 `ClientHandle` 增加：

```text
publish_enqueue_gate: Mutex<()>
publish_tracker: Mutex<PublishOperationTracker>
```

tracker 内部至少维护：

```text
awaiting_outgoing: VecDeque<operation_id>
operations: HashMap<operation_id, PendingPublish>
by_packet_id: HashMap<u16, operation_id>
```

启动发布时，只在以下短临界区持有 `publish_enqueue_gate`：

1. 注册 operation，并追加到 `awaiting_outgoing`。
2. 调用 `AsyncClient::publish`，把请求写入 rumqttc channel。
3. enqueue 失败时按 operation ID 撤销或标记 failed。

该 gate 不能持有到 ACK，否则会把所有发布串行化。它的唯一职责是保证 tracker FIFO
顺序与 rumqttc request channel 顺序一致。rumqttc 明确按顺序逐个处理 Request，因此下一个
`Outgoing::Publish` 可以安全绑定 FIFO 队首。

事件处理：

- `Outgoing::Publish(pkid)`：弹出 FIFO 队首，写入 `by_packet_id`，发出 `sent`。
- QoS 0 的 `pkid == 0`：直接完成为 `sent`。
- PUBACK：按 packet ID 完成 QoS 1。
- PUBREC：校验 QoS 2；成功则继续等待，拒绝则 failed。
- PUBCOMP：按 packet ID 完成 QoS 2。
- 未匹配 ACK：记录诊断信息，不得完成任意 operation。
- disconnect/event loop error：当前连接的所有 pending/sent operation 全部 failed。
- timeout：目标 operation failed，后续 ACK 只作为 unmatched ACK 处理。

超时发生在 `Outgoing::Publish` 之前时，FIFO 中需要保留 tombstone，直到对应 Outgoing
到达或连接关闭。直接删除队列项会让该 Outgoing 错绑到下一次发布。

tracker 应归属于 `ClientHandle`，天然以 connection ID 隔离 packet ID 的复用。重连时先
失败并清空旧 tracker，不能只用 `server_id + packet_id` 作为全局键。

### 3. 统一 Tauri 发布入口

所有 UI 发布路径统一调用高层 `publish_message`，不再让批量定时发布直接调用裸
`mqtt_publish`。

建议由前端在调用前生成 `crypto.randomUUID()`，放进 `PublishPayload.operation_id`。这样
前端能在 Tauri 调用尚未返回时立刻插入 pending 项，且 Tauri、tracker、SQLite、实时列表
共享同一 ID。Rust/SQLite 仍需校验唯一性。

推荐调用过程：

```text
frontend creates operation_id and pending row in store
  -> publish_message inserts pending history into SQLite
  -> MqttManager registers tracker and enqueues publish
  -> event loop emits mqtt-publish-state events
  -> command resolves on sent(QoS0), PUBACK(QoS1), or PUBCOMP(QoS2)
  -> publish_message persists terminal status and returns result
```

命令是异步等待，不会阻塞 UI 线程。手动发布可以 await 最终结果；定时/批量发布应把每个
operation 的 Promise 独立跟踪，以 operation ID 更新计数和日志，不能让单条 rejected、
timeout 或 disconnect 停止整个批次。

### 4. 先写 pending 历史，再发送

推荐扩展 `message_history`：

```sql
operation_id TEXT NULL,
publish_status TEXT NULL,
packet_id INTEGER NULL,
publish_error TEXT NULL,
sent_at TEXT NULL,
confirmed_at TEXT NULL
```

并建立部分唯一索引：

```sql
CREATE UNIQUE INDEX ... ON message_history(operation_id)
WHERE operation_id IS NOT NULL;
```

顺序必须是：

1. 插入 pending 历史。
2. 尝试 enqueue。
3. enqueue/ACK/timeout/disconnect 后更新同一行。

这样 MQTT 或脚本失败不会被记录成成功。数据库插入失败时应阻止发送，否则无法满足
operation ID 跨层关联要求。

现有 `CREATE TABLE IF NOT EXISTS` 不会给旧数据库增加列。必须增加显式、幂等的 schema
迁移，建议使用 `PRAGMA user_version` + transaction + `ALTER TABLE`，并为升级路径写测试。

旧发布记录无法追溯 Broker ACK：

- QoS 0 可迁移为 `sent`。
- QoS 1/2 应保留 NULL，并在 UI 中显示“未跟踪”，不能伪造 confirmed。
- 启动时发现遗留 pending，应更新为 failed，原因标记为应用在确认前退出。

### 5. 前端只保留一个发布入口

建议在 store 层提供一个 `publishTrackedMessage`：

1. 生成 operation ID 和 seq。
2. 立即 upsert pending 实时消息。
3. 调用 `publish_message`。
4. 监听 `mqtt-publish-state`，按 operation ID 更新 status/packet ID/error。
5. 最终历史记录按 operation ID 合并。

需要调整：

- `MqttMessage`、`MessageHistory`、`PublishPayload` 增加发布状态字段。
- `MessageList.getMessageKey` 首先使用 operation ID。
- MessageList 显示 pending/sent/confirmed/failed，failed 展示原因。
- 手动、定时消息和批量定时发布都调用同一 store action。
- Scheduled 日志按 operation ID 更新，不能只在 invoke 返回时记 success。

当前定时消息使用 `setInterval`，发送耗时超过间隔时会重叠。允许并发时应设置明确的
in-flight 上限；不允许重叠时改为一次 settled 后再 `setTimeout`。无论采用哪种策略，单条
失败只更新自己的 operation，不停止调度器。

## 建议实施顺序

1. 新建纯 Rust `PublishOperationTracker`，先完成状态机单测。
2. 扩展 V3/V5 `ProtocolEvent` 映射和 event loop 处理。
3. 给 `MqttManager` 增加短期 enqueue gate、FIFO 绑定和 disconnect/timeout 清理。
4. 增加 SQLite schema migration、pending 插入和按 operation ID 更新。
5. 扩展 Tauri payload/result/event 契约。
6. 前端 store 接入 pending/upsert/event 更新，并让 MessageList 用 operation ID 去重。
7. 迁移 PublishPanel、Timed Message、ScheduledPublishDialog 到统一发布入口。
8. 完成 broker 集成测试和前端回归测试。

## 必须覆盖的测试

### Rust tracker

- QoS 0 在 `Outgoing::Publish(0)` 后为 sent。
- QoS 1 只在匹配 PUBACK 后 confirmed。
- QoS 2 在 PUBREC 后仍未完成，只在 PUBCOMP 后 confirmed。
- 两个相同 Topic/Payload 的并发发布按 FIFO/packet ID 正确关联。
- ACK 乱序、重复 ACK、未知 packet ID 不误完成其他 operation。
- enqueue error、timeout、disconnect 全部给出 failed 原因。
- timeout-before-outgoing 不导致下一次发布错绑。
- MQTT 5 拒绝 reason code 进入 failed。

### Broker 集成

- MQTT 3.1.1 和 5.0 分别覆盖 QoS 0/1/2。
- Broker 延迟 ACK、拒绝 ACK、断开连接、乱序确认。
- 并发发送相同 Topic/Payload，验证只按 packet ID 关联。

### SQLite

- 旧表升级后列和部分唯一索引存在。
- pending/sent/confirmed/failed 更新同一行。
- 旧 QoS 1/2 历史不会显示为 confirmed。
- 启动时遗留 pending 被标记 failed。

### Frontend

- pending 立即可见，事件按 operation ID 更新。
- 历史与实时项按 operation ID 去重。
- failed 显示 reason，QoS 0 显示 sent，QoS 1/2 显示 confirmed。
- 定时消息慢 ACK 时的并发策略可预测。
- 批量单条失败后其他条目和后续轮次继续。

## 调查验证

已运行：

```text
cargo test --manifest-path src-tauri/Cargo.toml mqtt::subscription::tests -- --nocapture
结果：5 passed

cargo test --manifest-path src-tauri/Cargo.toml mqtt::client::tests -- --nocapture
结果：16 passed
```

前端相关测试：

```text
npm test -- --run src/stores/mqtt.test.ts \
  src/components/mqtt/PublishPanel.test.ts \
  src/components/mqtt/ScheduledPublishDialog.test.ts \
  src/components/mqtt/MessageList.test.ts
```

结果：3 个测试文件通过，共 59 个测试通过；`MessageList.test.ts` 在收集阶段失败，原因是
现有 mock 中 `mockSave` 被 `vi.mock` 提升后发生初始化时序错误。该失败存在于当前代码
基线，与本调查文档无关，但实施 issue #15 前应修复，以便新增 MessageList 状态测试。
