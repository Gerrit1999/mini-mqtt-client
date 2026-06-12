# PRD: MQTT 本地历史存储迁移到 SQLite

## 背景

当前项目的消息历史以本地 YAML 文件保存。每次接收消息都会追加写入整份数据文件，数据量增长后会带来明显的写放大和性能退化风险。长连接、高频消息场景下，客户端更容易出现卡顿、保存变慢、事件堆积，进而影响连接稳定性。

现有需求已经包含：
- 按 server 查看消息历史
- 按时间范围、Topic、方向筛选
- 分页加载更多历史
- 导出本地历史
- 清空某个 server 的历史

这些能力适合落到 SQLite 这种结构化存储上。

## 目标

1. 将消息历史存储从 YAML 迁移到 SQLite。
2. 保持现有功能不回退：历史查询、分页、搜索、导出、清理都继续可用。
3. 降低长连接下的写盘压力，提升消息接收稳定性。
4. 为后续按服务器、按时间范围查询提供标准索引能力。

## 非目标

1. 不重构 MQTT 连接协议层。
2. 不改变消息展示的交互逻辑。
3. 不在本期强制修改命令模板、脚本、订阅等其他数据结构，除非它们与数据库迁移强相关。

## 现状问题

1. 消息历史和其他配置混在同一份本地数据中。
2. 每条接收消息都会触发一次完整数据保存。
3. 历史查询主要依赖内存数组过滤与反转，缺少数据库索引。
4. 导出和清理虽然能做，但底层成本会随历史量持续上升。

## 方案概述

引入 SQLite 作为消息历史的专用持久化层。

建议保留两类存储：
- 配置类数据：继续按当前方式保存，或后续再评估是否一起迁入 SQLite。
- 消息历史：优先迁入 SQLite，作为本次 PRD 的核心范围。

### 核心表设计

```sql
CREATE TABLE message_history (
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

CREATE INDEX idx_message_history_server_created_at
ON message_history(server_id, created_at DESC);

CREATE INDEX idx_message_history_server_topic_created_at
ON message_history(server_id, topic, created_at DESC);
```

## 用户故事

1. 作为用户，我希望长时间保持连接时，客户端仍然稳定，不因为历史消息越来越多而变慢。
2. 作为用户，我希望能按 server 查询本地历史消息。
3. 作为用户，我希望能继续分页加载历史消息。
4. 作为用户，我希望能继续导出某个 server 的全部本地历史。
5. 作为用户，我希望清空某个 server 的历史时只影响该 server。

## 功能范围

### 1. 写入

- 接收消息后立即写入 SQLite。
- 发布消息成功后同步写入 SQLite。
- 写入成功后返回标准历史记录对象。
- 写入失败时不影响 MQTT 主连接，但要记录错误并可见。

### 2. 查询

- 按 `server_id` 查询。
- 支持 `limit + offset` 分页。
- 支持按时间倒序分页。
- 支持后续扩展时间范围、Topic、方向筛选。

### 3. 导出

- 继续支持导出 JSON/CSV。
- 导出源改为 SQLite 查询结果。
- 支持导出某个 server 的全部本地历史。

### 4. 清理

- 清空某个 server 的历史，只删除该 server 的消息。
- 清空全部历史，删除所有消息记录。

### 5. 迁移

- 启动时检测旧 YAML 历史数据。
- 首次升级时将旧消息迁入 SQLite。
- 迁移成功后保留回滚能力，但不再依赖 YAML 作为主存储。

## 数据兼容策略

1. 旧版本 YAML 中的消息历史需要迁移一次。
2. 迁移时按原消息字段映射到 SQLite。
3. 迁移完成后，为避免重复导入，需要写入迁移标记。
4. 若迁移失败，应用应继续启动，但要提示历史导入未完成。

## 验收标准

1. 长连接高频收消息时，客户端不再因历史写盘放大明显变慢。
2. 消息历史查询结果与当前行为一致。
3. 分页加载仍然正确。
4. 导出结果覆盖本地历史，不丢消息。
5. 清空历史后，该 server 的历史记录完全消失。
6. 旧 YAML 历史可成功迁移到 SQLite。

## 风险与注意事项

1. 迁移时可能重复导入，需要幂等控制。
2. SQLite 文件可能随历史增长变大，但增长是可控且可索引的。
3. 如果消息 payload 很大，写入策略需要确认是否继续用 TEXT 存储，还是改为 BLOB + 编码字段。
4. 前端内存仍然只保留当前视图窗口，避免把数据库问题重新搬回 UI。

## 建议实施顺序

1. 先建 SQLite 消息表和基础 DAO。
2. 接入接收消息写入路径。
3. 接入历史查询、分页、导出、清理。
4. 做旧 YAML 迁移。
5. 补测试和回归验证。

## 交付物

- SQLite 消息历史表结构
- Rust 端存取实现
- 旧数据迁移逻辑
- 前端历史查询/导出兼容
- 回归测试用例
