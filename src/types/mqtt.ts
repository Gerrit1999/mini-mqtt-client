/**
 * MQTT Server 配置
 */
export type MqttTransportProtocol = "mqtt" | "mqtts" | "ws" | "wss";
export type MqttCertificateType = "ca_signed" | "self_signed";
export type MqttProtocolVersion = "3.1.1" | "5.0";
export type MqttCapability =
  | "publish_properties"
  | "session_expiry"
  | "topic_alias";

export interface MqttServer {
  id?: number;
  name: string;
  host: string;
  port: number;
  protocol?: MqttTransportProtocol;
  websocket_path?: string;
  protocol_version: MqttProtocolVersion;
  username?: string;
  password?: string;
  client_id?: string;
  keep_alive: number;
  clean_session: boolean;
  use_tls: boolean;
  ssl_secure?: boolean;
  alpn?: string;
  certificate_type?: MqttCertificateType;
  ca_cert?: string;
  client_cert?: string;
  client_key?: string;
  client_key_password?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 命令模板
 */
export interface CommandTemplate {
  id?: number;
  /** `0` = global (all connections). */
  server_id: number;
  name: string;
  topic: string;
  payload?: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  category?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * MQTT 消息 (实时)
 */
export interface MqttMessage {
  id?: number;
  server_id: number;
  direction: "publish" | "receive";
  topic: string;
  payload?: Uint8Array;
  qos: 0 | 1 | 2;
  retain: boolean;
  timestamp?: string;
  /** 脚本处理错误信息 */
  scriptError?: string;
  /** 消息格式类型（发送时用户选择的格式） */
  payload_type?: "json" | "hex" | "text";
  /** 单调递增序列号，用于保证消息显示顺序 */
  seq?: number;
  operation_id?: string;
  publish_status?: PublishRuntimeStatus;
  packet_id?: number;
  publish_error?: string;
  sent_at?: string;
  confirmed_at?: string;
}

export type PublishRuntimeStatus = "pending" | "sent" | "confirmed" | "failed";

export interface PublishRuntimeState {
  operation_id: string;
  server_id: number;
  qos: 0 | 1 | 2;
  status: PublishRuntimeStatus;
  packet_id?: number;
  error?: string;
}

/**
 * 订阅类型
 */
export interface Subscription {
  id?: number;
  server_id: number;
  topic: string;
  qos: number;
  is_active: boolean;
  /** 订阅的颜色标记（用于消息列表中高亮显示） */
  color?: string;
  created_at?: string;
}

export type SubscriptionOperation = "subscribe" | "unsubscribe";
export type SubscriptionRuntimeStatus =
  | "disabled"
  | "pending"
  | "active"
  | "failed";

export interface SubscriptionRuntimeState {
  server_id: number;
  topic: string;
  operation: SubscriptionOperation;
  status: SubscriptionRuntimeStatus;
  requested_qos?: 0 | 1 | 2;
  granted_qos?: 0 | 1 | 2;
  error?: string;
  operation_id: string;
}

export interface SubscriptionOperationResult {
  operation_id: string;
  granted_qos?: 0 | 1 | 2;
}

/**
 * 更新订阅请求
 */
export interface UpdateSubscriptionRequest {
  id: number;
  topic?: string;
  qos?: number;
  color?: string;
}

/**
 * 消息历史类型
 */
export interface MessageHistory {
  id?: number;
  server_id: number;
  topic: string;
  payload?: string;
  payload_format?: "text" | "json" | "hex";
  direction: "publish" | "receive";
  qos: number;
  retain: boolean;
  created_at?: string;
  operation_id?: string;
  publish_status?: PublishRuntimeStatus;
  packet_id?: number;
  publish_error?: string;
  sent_at?: string;
  confirmed_at?: string;
}

/**
 * 发布消息载荷
 */
export interface PublishPayload {
  operation_id: string;
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  format: "text" | "json" | "hex";
}

/**
 * 连接状态
 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * 环境变量
 */
export interface EnvVariable {
  id?: number;
  server_id: number;
  name: string;
  value: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 创建环境变量请求
 */
export interface CreateEnvVariableRequest {
  server_id: number;
  name: string;
  value: string;
  description?: string;
}

/**
 * 更新环境变量请求
 */
export interface UpdateEnvVariableRequest {
  id: number;
  name?: string;
  value?: string;
  description?: string;
}

export function generateDefaultClientId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `mqtt_${Date.now()}_${random}`;
}

/**
 * 创建默认 Server 配置
 */
export function createDefaultServer(): MqttServer {
  return {
    name: "",
    host: "",
    port: 1883,
    protocol: "mqtt",
    websocket_path: "/mqtt",
    protocol_version: "5.0",
    username: "",
    password: "",
    client_id: generateDefaultClientId(),
    keep_alive: 60,
    clean_session: true,
    use_tls: false,
    ssl_secure: true,
    alpn: "",
    certificate_type: "ca_signed",
    ca_cert: "",
    client_cert: "",
    client_key: "",
    client_key_password: "",
  };
}
