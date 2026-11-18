import { errorHandler, ErrorType } from './errorHandler'
import i18n from '@/i18n'

/**
 * MQTT 错误信息接口
 */
export interface MqttErrorInfo {
  code: string
  message: string
  suggestion: string
}

/**
 * MQTT 连接状态
 */
export type MqttConnectionStatus = 
  | 'disconnected' 
  | 'connecting' 
  | 'connected' 
  | 'reconnecting' 
  | 'error'

/**
 * MQTT 错误映射表
 */
const mqttErrorMap: Record<string, MqttErrorInfo> = {
  'connection_refused': {
    code: 'CONNECTION_REFUSED',
    message: '连接被拒绝',
    suggestion: '请检查服务器地址和端口是否正确'
  },
  'connection_timeout': {
    code: 'CONNECTION_TIMEOUT',
    message: '连接超时',
    suggestion: '请检查网络连接或服务器是否可用'
  },
  'connection refused': {
    code: 'CONNECTION_REFUSED',
    message: '连接被拒绝',
    suggestion: '请检查服务器地址和端口是否正确'
  },
  'timeout': {
    code: 'CONNECTION_TIMEOUT',
    message: '连接超时',
    suggestion: '请检查网络连接或服务器是否可用'
  },
  'auth_failed': {
    code: 'AUTH_FAILED',
    message: '认证失败',
    suggestion: '请检查用户名和密码是否正确'
  },
  'authentication': {
    code: 'AUTH_FAILED',
    message: '认证失败',
    suggestion: '请检查用户名和密码是否正确'
  },
  'bad user name or password': {
    code: 'AUTH_FAILED',
    message: '用户名或密码错误',
    suggestion: '请检查用户名和密码是否正确'
  },
  'not_authorized': {
    code: 'NOT_AUTHORIZED',
    message: '未授权',
    suggestion: '当前用户没有该操作权限'
  },
  'not authorized': {
    code: 'NOT_AUTHORIZED',
    message: '未授权',
    suggestion: '当前用户没有该操作权限'
  },
  'topic_invalid': {
    code: 'TOPIC_INVALID',
    message: '主题格式无效',
    suggestion: '请检查主题格式是否符合MQTT规范'
  },
  'invalid topic': {
    code: 'TOPIC_INVALID',
    message: '主题格式无效',
    suggestion: '请检查主题格式是否符合MQTT规范'
  },
  'payload_too_large': {
    code: 'PAYLOAD_TOO_LARGE',
    message: '消息体过大',
    suggestion: '请减小消息体大小'
  },
  'packet too large': {
    code: 'PAYLOAD_TOO_LARGE',
    message: '消息包过大',
    suggestion: '请减小消息体大小'
  },
  'disconnected': {
    code: 'DISCONNECTED',
    message: '连接已断开',
    suggestion: '请重新连接服务器'
  },
  'network': {
    code: 'NETWORK_ERROR',
    message: '网络错误',
    suggestion: '请检查网络连接是否正常'
  },
  'io error': {
    code: 'IO_ERROR',
    message: 'IO错误',
    suggestion: '请检查网络连接或重试'
  },
  'broker unavailable': {
    code: 'BROKER_UNAVAILABLE',
    message: '服务器不可用',
    suggestion: '请检查服务器是否正常运行'
  },
  'client identifier not valid': {
    code: 'INVALID_CLIENT_ID',
    message: 'Client ID 无效',
    suggestion: '请检查 Client ID 格式是否正确'
  },
  'protocol': {
    code: 'PROTOCOL_ERROR',
    message: '协议错误',
    suggestion: '请检查 MQTT 协议版本是否匹配'
  }
}

const mqttOsErrors = {
  CONNECTION_REFUSED: mqttErrorMap.connection_refused,
  CONNECTION_TIMEOUT: mqttErrorMap.connection_timeout,
  CONNECTION_RESET: {
    code: 'CONNECTION_RESET',
    message: '连接被重置',
    suggestion: '请检查服务器和网络连接后重试'
  },
  DISCONNECTED: mqttErrorMap.disconnected,
  DNS_ERROR: {
    code: 'DNS_ERROR',
    message: '无法解析服务器地址',
    suggestion: '请检查服务器主机名和 DNS 设置'
  }
} satisfies Record<string, MqttErrorInfo>

type MqttOsErrorCode = keyof typeof mqttOsErrors
type OsErrorCodes = Partial<Record<number, MqttOsErrorCode>>

const windowsErrorCodes: OsErrorCodes = {
  10053: 'DISCONNECTED',
  10054: 'CONNECTION_RESET',
  10060: 'CONNECTION_TIMEOUT',
  10061: 'CONNECTION_REFUSED',
  11001: 'DNS_ERROR',
  11002: 'DNS_ERROR',
  11003: 'DNS_ERROR',
  11004: 'DNS_ERROR'
}

const linuxErrorCodes: OsErrorCodes = {
  103: 'DISCONNECTED',
  104: 'CONNECTION_RESET',
  110: 'CONNECTION_TIMEOUT',
  111: 'CONNECTION_REFUSED'
}

const macErrorCodes: OsErrorCodes = {
  53: 'DISCONNECTED',
  54: 'CONNECTION_RESET',
  60: 'CONNECTION_TIMEOUT',
  61: 'CONNECTION_REFUSED'
}

function matchMqttTextError(error: string): MqttErrorInfo | undefined {
  const lowerError = error.toLowerCase()
  return Object.entries(mqttErrorMap).find(([key]) => lowerError.includes(key))?.[1]
}

function getMqttOsErrorCode(error: string): MqttOsErrorCode | undefined {
  const match = /\(os error (\d+)\)\s*$/.exec(error)
  if (!match) return

  // TLS、WebSocket 和英文错误详情沿用原有的文本处理。
  if (matchMqttTextError(error) ||
      /\b(?:tls|certificate|websocket|timed out|connection reset|connection aborted|failed to lookup|dns)\b/i.test(error)) {
    return
  }

  const code = Number(match[1])
  const platform = globalThis.navigator?.platform ?? ''
  if (platform.startsWith('Win')) return windowsErrorCodes[code]
  if (platform.startsWith('Linux')) return linuxErrorCodes[code]
  if (platform.startsWith('Mac')) return macErrorCodes[code]
}

export function formatMqttOsError(error: string): string | undefined {
  const code = getMqttOsErrorCode(error)
  if (code) return i18n.global.t('errors.mqttSocket.' + code, { details: error })
}

/**
 * 处理 MQTT 错误
 * @param error 错误字符串
 * @param silent 是否静默处理
 * @param context 请求上下文
 * @returns MQTT 错误信息
 */
export function handleMqttError(error: string, silent: boolean = false, context?: Record<string, unknown>): MqttErrorInfo {
  const osCode = getMqttOsErrorCode(error)
  const info = osCode ? mqttOsErrors[osCode] : matchMqttTextError(error)
  if (info) {
    if (!silent) {
      errorHandler.handle({ message: `${info.message}: ${info.suggestion}`, reason: error, code: info.code }, ErrorType.MQTT, false, context)
    }
    return info
  }

  // 未知 MQTT 错误
  const unknownError: MqttErrorInfo = {
    code: 'UNKNOWN',
    message: error,
    suggestion: '请查看详细日志获取更多信息'
  }
  
  if (!silent) {
    errorHandler.handle(error, ErrorType.MQTT, false, context)
  }
  
  return unknownError
}

/**
 * 检查 MQTT 是否已连接
 */
export function isMqttConnected(status: MqttConnectionStatus): boolean {
  return status === 'connected'
}

/**
 * 获取 MQTT 状态显示信息
 */
export function getMqttStatusInfo(status: MqttConnectionStatus): { 
  text: string
  type: 'success' | 'warning' | 'danger' | 'info' 
  icon?: string
} {
  const t = i18n.global.t
  const statusMap: Record<MqttConnectionStatus, { text: string; type: 'success' | 'warning' | 'danger' | 'info' }> = {
    'disconnected': { text: t('header.status.disconnected'), type: 'info' },
    'connecting': { text: t('header.status.connecting'), type: 'warning' },
    'connected': { text: t('header.status.connected'), type: 'success' },
    'reconnecting': { text: t('header.status.connecting'), type: 'warning' },
    'error': { text: t('header.status.error'), type: 'danger' }
  }
  
  return statusMap[status] || { text: status, type: 'info' }
}

/**
 * 获取 MQTT 错误建议
 * @param errorCode 错误代码
 */
export function getMqttErrorSuggestion(errorCode: string): string {
  for (const info of [...Object.values(mqttErrorMap), ...Object.values(mqttOsErrors)]) {
    if (info.code === errorCode) {
      return info.suggestion
    }
  }
  return '请查看详细日志获取更多信息'
}

/**
 * 验证 MQTT Topic 格式
 * @param topic Topic 字符串
 * @returns 验证结果
 */
export function validateMqttTopic(topic: string): { valid: boolean; error?: string } {
  if (!topic || topic.trim() === '') {
    return { valid: false, error: 'Topic 不能为空' }
  }
  
  if (new TextEncoder().encode(topic).length > 65535) {
    return { valid: false, error: 'Topic 长度超过限制' }
  }
  
  // 检查是否包含空字符
  if (topic.includes('\0')) {
    return { valid: false, error: 'Topic 不能包含空字符' }
  }
  
  // 检查是否以 / 开头（不推荐但允许）
  // if (topic.startsWith('/')) {
  //   return { valid: true, warning: 'Topic 以 / 开头不推荐' }
  // }
  
  return { valid: true }
}

/**
 * 验证 MQTT 发布 Topic（不允许通配符）
 * @param topic Topic 字符串
 */
export function validatePublishTopic(topic: string): { valid: boolean; error?: string } {
  const baseValidation = validateMqttTopic(topic)
  if (!baseValidation.valid) {
    return baseValidation
  }
  
  // 发布主题不能包含通配符
  if (topic.includes('+') || topic.includes('#')) {
    return { valid: false, error: '发布主题不能包含通配符 (+ 或 #)' }
  }
  
  return { valid: true }
}

/**
 * 验证 MQTT 订阅 Topic（允许通配符）
 * @param topic Topic 字符串
 */
export function validateSubscribeTopic(topic: string): { valid: boolean; error?: string } {
  const baseValidation = validateMqttTopic(topic)
  if (!baseValidation.valid) {
    return baseValidation
  }
  
  // 通配符必须各自占据完整层级，# 只能出现在末尾层级
  const parts = topic.split('/')
  for (const [index, part] of parts.entries()) {
    if (part.includes('#') && (part !== '#' || index !== parts.length - 1)) {
      return { valid: false, error: '# 通配符只能单独占据主题末尾层级' }
    }
    if (part.includes('+') && part !== '+') {
      return { valid: false, error: '+ 通配符必须单独占据一个主题层级' }
    }
  }
  
  return { valid: true }
}
