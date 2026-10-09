import { ElNotification } from 'element-plus'
import { errorLogBuffer, stableSerialize } from './errorLogBuffer'

/**
 * 错误类型枚举
 */
export enum ErrorType {
  NETWORK = 'network',
  MQTT = 'mqtt',
  DATABASE = 'database',
  VALIDATION = 'validation',
  SCRIPT = 'script',
  UNKNOWN = 'unknown'
}

/**
 * 应用错误接口
 */
export interface AppError {
  type: ErrorType
  message: string
  details?: any
  context?: Record<string, unknown>
  timestamp: Date
}

/**
 * 错误类型对应的标题
 */
const errorTitles: Record<ErrorType, string> = {
  [ErrorType.NETWORK]: '网络错误',
  [ErrorType.MQTT]: 'MQTT错误',
  [ErrorType.DATABASE]: '数据库错误',
  [ErrorType.VALIDATION]: '验证错误',
  [ErrorType.SCRIPT]: '脚本错误',
  [ErrorType.UNKNOWN]: '错误'
}

/**
 * 全局错误处理器类
 */
class ErrorHandler {
  private errors: AppError[] = []
  private maxErrors = 100
  private logToFileEnabled = true

  /**
   * 处理错误
   * @param error 错误对象
   * @param type 错误类型
   * @param silent 是否静默处理（不显示通知）
   */
  handle(error: unknown, type: ErrorType = ErrorType.UNKNOWN, silent: boolean = false, context?: Record<string, unknown>): AppError {
    const appError = this.createAppError(error, type)
    appError.context = context
    this.logError(appError)
    this.storeError(appError)
    
    if (!silent) {
      this.notifyUser(appError)
    }
    
    // UI 保留逐次错误；磁盘缓冲独立聚合，清空 UI 不会清空待写日志。
    if (this.logToFileEnabled) {
      errorLogBuffer.enqueue(appError)
    }
    
    return appError
  }

  /**
   * 创建应用错误对象
   */
  private createAppError(error: unknown, type: ErrorType): AppError {
    let message = '发生未知错误'
    let details: any

    if (error instanceof Error) {
      message = error.message
      details = {
        ...error,
        name: error.name,
        stack: error.stack,
        cause: (error as Error & { cause?: unknown }).cause
      }
    } else if (typeof error === 'string') {
      message = error
    } else if (error && typeof error === 'object') {
      message = String((error as any).message || stableSerialize(error))
      details = error
    } else {
      details = error
    }

    return {
      type,
      message,
      details,
      timestamp: new Date()
    }
  }

  /**
   * 控制台输出错误
   */
  private logError(error: AppError): void {
    console.error(`[${error.type.toUpperCase()}] ${error.message}`, error.details)
  }

  /**
   * 存储错误到内存
   */
  private storeError(error: AppError): void {
    this.errors.unshift(error)
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(0, this.maxErrors)
    }
  }

  /**
   * 向用户显示错误通知
   */
  private notifyUser(error: AppError): void {
    ElNotification({
      title: errorTitles[error.type],
      message: error.message,
      type: 'error',
      duration: 5000
    })
  }

  /**
   * 写入错误日志到文件
   */
  flush(): Promise<void> {
    return errorLogBuffer.flush()
  }

  /**
   * 获取所有错误记录
   */
  getErrors(): AppError[] {
    return [...this.errors]
  }

  /**
   * 获取指定类型的错误
   */
  getErrorsByType(type: ErrorType): AppError[] {
    return this.errors.filter(e => e.type === type)
  }

  /**
   * 清空错误记录
   */
  clearErrors(): void {
    this.errors = []
  }

  /**
   * 设置是否启用日志文件记录
   */
  setLogToFileEnabled(enabled: boolean): void {
    this.logToFileEnabled = enabled
  }

  /**
   * 获取最近的错误
   */
  getLatestError(): AppError | null {
    return this.errors.length > 0 ? this.errors[0] : null
  }

  /**
   * 获取错误数量
   */
  getErrorCount(): number {
    return this.errors.length
  }
}

// 导出单例实例
export const errorHandler = new ErrorHandler()

/**
 * 设置全局错误捕获
 * 在 main.ts 中调用
 */
export function setupGlobalErrorHandler(): void {
  // 捕获未处理的 JavaScript 错误
  window.addEventListener('error', (event) => {
    errorHandler.handle(event.error || event.message, ErrorType.UNKNOWN)
  })

  // 捕获未处理的 Promise 拒绝
  window.addEventListener('unhandledrejection', (event) => {
    errorHandler.handle(event.reason, ErrorType.UNKNOWN)
  })

  console.log('[ErrorHandler] 全局错误处理器已初始化')
}

/**
 * 便捷函数：处理网络错误
 */
export function handleNetworkError(error: unknown, silent = false): AppError {
  return errorHandler.handle(error, ErrorType.NETWORK, silent)
}

/**
 * 便捷函数：处理 MQTT 错误
 */
export function handleMqttError(error: unknown, silent = false): AppError {
  return errorHandler.handle(error, ErrorType.MQTT, silent)
}

/**
 * 便捷函数：处理数据库错误
 */
export function handleDatabaseError(error: unknown, silent = false): AppError {
  return errorHandler.handle(error, ErrorType.DATABASE, silent)
}

/**
 * 便捷函数：处理验证错误
 */
export function handleValidationError(error: unknown, silent = false): AppError {
  return errorHandler.handle(error, ErrorType.VALIDATION, silent)
}

/**
 * 便捷函数：处理脚本错误
 */
export function handleScriptError(error: unknown, silent = false, context?: Record<string, unknown>): AppError {
  return errorHandler.handle(error, ErrorType.SCRIPT, silent, context)
}
