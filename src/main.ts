import { createSSRApp } from 'vue'
import * as Pinia from 'pinia'
import App from './App.vue'
// #ifdef APP-PLUS
import { useAppearanceStore } from './store/appearance'
// #endif
export function createApp() {
  const app = createSSRApp(App)
  app.use(Pinia.createPinia())
  // #ifdef APP-PLUS
  // 原生 Tab 在页面就绪后才能着色，二级页返回时也要同步状态栏。
  app.mixin({
    onReady() {
      useAppearanceStore().syncNavigation()
    },
    onShow() {
      useAppearanceStore().syncNavigation()
    },
  })
  // #endif
  return {
    app,
    Pinia,
  }
}
