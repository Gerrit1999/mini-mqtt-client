import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ElNotification } from 'element-plus'
import { errorLogBuffer } from './errorLogBuffer'

// Native close is held until all queued writes settle. Failed persistence keeps
// the window open so the user can retry; reporting must bypass the error buffer.
export async function setupErrorLogLifecycle(beforeDestroy?: () => Promise<void>): Promise<() => void> {
  const report = (error: unknown) => {
    console.error('退出前写入错误日志失败:', error)
    ElNotification({
      title: '错误日志未保存',
      message: '退出前保存错误日志失败，请稍后重试关闭窗口。',
      type: 'error',
      duration: 8000,
    })
  }
  const beforeUnload = () => {
    // Browsers cannot await asynchronous work during unload.
    void errorLogBuffer.flush().catch(report)
  }
  window.addEventListener('beforeunload', beforeUnload)
  let unlisten: (() => void) | undefined
  let closing = false
  if (isTauri()) {
    try {
      const appWindow = getCurrentWindow()
      unlisten = await appWindow.onCloseRequested(async event => {
        event.preventDefault()
        if (closing) return
        closing = true
        try {
          await errorLogBuffer.flush()
          await beforeDestroy?.()
          // destroy avoids another closeRequested event and lets us catch native
          // close failures too (the API's implicit destroy would be out-of-band).
          await appWindow.destroy()
        } catch (error) {
          report(error)
        } finally {
          closing = false
        }
      })
    } catch (error) {
      report(error)
    }
  }
  return () => {
    unlisten?.()
    window.removeEventListener('beforeunload', beforeUnload)
  }
}
