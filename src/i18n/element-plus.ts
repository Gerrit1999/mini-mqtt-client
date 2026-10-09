import { reactive } from "vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import en from "element-plus/es/locale/lang/en";
import i18n from "./index";

export const getElementLocale = (locale: string) => locale === "zh-CN" ? zhCn : en;

// Follow the displayed language, including the fallback after a failed load.
export const elementPlusLocaleOptions = reactive({
  get locale() { return getElementLocale(i18n.global.locale.value); },
});
