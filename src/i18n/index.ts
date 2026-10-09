import { createI18n, type LocaleMessages, type VueMessageType } from 'vue-i18n'
import enUS from './locales/en-US.yaml'

export type Locale = 'auto' | 'zh-CN' | 'en-US'
export type ActualLocale = 'zh-CN' | 'en-US'

// 支持的语言列表
export const supportedLocales: ActualLocale[] = ['zh-CN', 'en-US']
export const defaultLocale: ActualLocale = 'en-US'

// 获取系统语言
export function getSystemLocale(): ActualLocale {
  const lang = navigator.language.toLowerCase()
  // 匹配中文
  if (lang.startsWith('zh')) {
    return 'zh-CN'
  }
  // 其他语言默认英文
  return 'en-US'
}

// 获取实际使用的语言
export function getActualLocale(locale: Locale): ActualLocale {
  if (locale === 'auto') {
    return getSystemLocale()
  }
  return supportedLocales.includes(locale) ? locale : defaultLocale
}

// 创建 i18n 实例
const i18n = createI18n({
  legacy: false, // 使用 Composition API 模式
  locale: defaultLocale, // 默认语言独立加载，在异步语言资源失败时仍可渲染
  fallbackLocale: defaultLocale,
  messages: {
    'en-US': enUS,
  } as Record<string, LocaleMessages<VueMessageType>>,
})

let chineseLoad: Promise<ActualLocale> | undefined

// Resource loading never changes the displayed locale; the caller guards stale requests.
export async function loadLocaleMessages(locale: ActualLocale): Promise<ActualLocale> {
  if (locale === defaultLocale || i18n.global.availableLocales.includes(locale)) return locale
  if (!chineseLoad) {
    chineseLoad = (async () => {
      try {
        const { default: messages } = await import('./locales/zh-CN.yaml')
        i18n.global.setLocaleMessage('zh-CN', messages as LocaleMessages<VueMessageType>)
        return 'zh-CN' as const
      } catch (error) {
        console.error('[i18n] Failed to load zh-CN locale; using en-US. Check the locale asset/network, then select the language again or restart the application.', error)
        return defaultLocale
      } finally {
        chineseLoad = undefined
      }
    })()
  }
  return chineseLoad
}

export default i18n
