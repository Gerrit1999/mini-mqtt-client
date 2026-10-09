/// <reference types="vite/client" />

declare module "*.yaml" {
  import type { LocaleMessages, VueMessageType } from "vue-i18n";
  const messages: LocaleMessages<VueMessageType>;
  export default messages;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
