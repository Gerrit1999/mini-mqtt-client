import { createApp } from "vue";
import ElementPlus from "element-plus";
import App from "./App.vue";
import pinia from "./stores";
import i18n from "./i18n";
import { getElementLocale, elementPlusLocaleOptions } from "./i18n/element-plus";
import { setupGlobalErrorHandler } from "./utils/errorHandler";
import { setupErrorLogLifecycle } from "./utils/errorLogLifecycle";
import { useUpdaterStore } from "./stores/updater";

// Element Plus 暗黑主题
import "element-plus/theme-chalk/dark/css-vars.css";

// Element Plus 消息框样式（API调用的组件需要手动导入样式）
import "element-plus/theme-chalk/el-message-box.css";
import "element-plus/theme-chalk/el-message.css";
import "element-plus/theme-chalk/el-overlay.css";

// 全局样式
import "./assets/styles/index.scss";

// 设置全局错误处理器
setupGlobalErrorHandler();
void setupErrorLogLifecycle(() => useUpdaterStore(pinia).dispose());

const app = createApp(App);

app.use(pinia);
app.use(i18n);
// Mount with the bundled fallback; App initializes the persisted preference.
app.use(ElementPlus, elementPlusLocaleOptions);
app.mount("#app");

// 导出用于动态切换 Element Plus 语言的方法
export { getElementLocale };
