import { defineStore } from 'pinia'
import palettes from '@/theme.json'

type Theme = 'light' | 'dark'
let following = false
const tabs = ['record', 'ideas', 'schedule', 'mine'] as const

// #ifdef APP-PLUS
// Android 9 的部分基座可读取夜间模式，但不会向 uni.onThemeChange 转发配置变化。
let legacyAndroid = false
let androidListener: PlusAndroidInstanceObject | undefined
function androidTheme(
  configuration?: PlusAndroidInstanceObject,
): Theme | undefined {
  const android = plus.android
  const config =
    configuration ??
    android.invoke(
      android.invoke('android.content.res.Resources', 'getSystem'),
      'getConfiguration',
    )
  const mode = Number(android.getAttribute(config, 'uiMode')) & 0x30
  return mode === 0x20 ? 'dark' : mode === 0x10 ? 'light' : undefined
}
function followAndroidConfiguration(onChange: (theme: Theme) => void) {
  if (androidListener) return
  const android = plus.android
  androidListener = android.implements('android.content.ComponentCallbacks', {
    onConfigurationChanged(configuration: PlusAndroidInstanceObject) {
      try {
        const theme = androidTheme(configuration)
        if (theme) onChange(theme)
      } catch (error) {
        console.warn('读取 Android 夜间模式失败', error)
      }
    },
    onLowMemory() {},
  })
  const application = android.invoke(
    android.runtimeMainActivity(),
    'getApplication',
  )
  android.invoke(application, 'registerComponentCallbacks', androidListener)
}

async function paintNativeNavigation(theme: Theme) {
  const pages = getCurrentPages()
  const page = pages[pages.length - 1]
  if (!page?.route) return
  const colors = palettes[theme]
  try {
    // 同时更新页面配置，之后系统切换页面时也能使用正确的状态栏文字颜色。
    const status = uni.setNavigationBarColor({
      frontColor: theme === 'dark' ? '#ffffff' : '#000000',
      backgroundColor: colors.background,
    })
    if (!tabs.some((name) => page.route === 'pages/' + name + '/index')) {
      await status
      return
    }
    await Promise.all([
      status,
      uni.setTabBarStyle({
        color: colors.muted,
        selectedColor: colors.primary,
        backgroundColor: colors.surface,
        borderStyle: theme === 'dark' ? 'white' : 'black',
      }),
      ...tabs.map((name, index) =>
        uni.setTabBarItem({
          index,
          iconPath: '/' + colors[name],
          selectedIconPath: '/' + colors[`${name}Selected`],
        }),
      ),
    ])
  } catch (error) {
    // 过渡期间原生窗口可能已经隐藏，下一页的 onReady/onShow 会重新应用。
    console.warn('页面导航外观暂未更新', error)
  }
}
// #endif

export const useAppearanceStore = defineStore('appearance', {
  state: () => ({ theme: '' as '' | Theme }),
  getters: {
    pageClass: (state) => (state.theme ? 'theme-' + state.theme : ''),
  },
  actions: {
    syncNavigation() {
      // #ifdef APP-PLUS
      const theme = this.theme
      if (theme) void paintNativeNavigation(theme)
      // #endif
    },
    setSystemTheme(theme: unknown) {
      if (theme !== 'dark' && theme !== 'light') return
      this.theme = theme
      // 在 uni-app 内建的主题事件处理后刷新；按执行时的最新主题绘制。
      void Promise.resolve().then(() => this.syncNavigation())
    },
    refreshSystemTheme() {
      try {
        // #ifdef H5
        if (typeof window !== 'undefined' && window.matchMedia) {
          this.setSystemTheme(
            window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light',
          )
          return
        }
        // #endif
        const info = uni.getSystemInfoSync()
        let theme: unknown = info.osTheme ?? info.theme
        // #ifdef APP-PLUS
        if (legacyAndroid) theme = androidTheme() ?? theme
        // #endif
        this.setSystemTheme(theme)
      } catch (error) {
        console.warn('读取系统外观失败', error)
      }
    },
    followSystem() {
      if (following) return
      following = true
      // #ifdef APP-PLUS
      plus.nativeUI.setUIStyle('auto')
      legacyAndroid =
        plus.os.name === 'Android' &&
        Number.parseInt(plus.os.version ?? '', 10) < 10
      if (legacyAndroid) {
        try {
          followAndroidConfiguration((theme) => this.setSystemTheme(theme))
        } catch (error) {
          console.warn('Android 外观监听未就绪', error)
        }
      }
      // #endif
      this.refreshSystemTheme()
      uni.onThemeChange(({ theme }) => this.setSystemTheme(theme))
    },
  },
})
