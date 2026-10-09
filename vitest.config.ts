import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";

// Existing component tests supply synthetic string messages. The focused i18n
// suite also runs with this flag to exercise the production runtime-only path.
const runtimeOnlyTests = process.env.I18N_RUNTIME_ONLY_TEST === "1";

export default defineConfig({
  plugins: [vue(), VueI18nPlugin({
    include: resolve(__dirname, "src/i18n/locales/**"),
    runtimeOnly: runtimeOnlyTests,
    dropMessageCompiler: runtimeOnlyTests,
  })],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
