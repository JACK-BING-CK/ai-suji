<script setup lang="ts">
interface Props {
  /** 当前页面的标题。 */
  title: string
  /** 二级页面显示返回按钮。 */
  back?: boolean
  /** 没有上一级页面时，返回的 Tab 绝对路径。 */
  fallbackTab?: string
}

const props = withDefaults(defineProps<Props>(), {
  fallbackTab: '/pages/record/index',
})

async function goBack() {
  try {
    if (getCurrentPages().length > 1) {
      await uni.navigateBack({ delta: 1 })
      return
    }
    await uni.switchTab({ url: props.fallbackTab })
  } catch {
    uni.showToast({ title: '返回失败，请重试', icon: 'none' })
  }
}
</script>

<template>
  <view class="app-nav">
    <view class="app-nav__bar">
      <button
        v-if="back"
        class="app-nav__back"
        aria-label="返回"
        hover-class="app-nav__pressed"
        @click="goBack"
      >
        <view aria-hidden="true" class="app-nav__chevron" />
      </button>
      <text
        class="app-nav__title"
        :class="{ 'app-nav__title--detail': back }"
        >{{ title }}</text
      >
      <view v-if="$slots.right" class="app-nav__actions"
        ><slot name="right"
      /></view>
    </view>
  </view>
</template>

<style scoped>
.app-nav {
  position: sticky;
  top: 0;
  z-index: 3;
  padding-top: var(--status-bar-height, 0px);
  padding-top: max(
    var(--status-bar-height, 0px),
    env(safe-area-inset-top, 0px)
  );
  background: var(--bg);
  color: var(--text);
}
.app-nav__bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-height: 64px;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 4px var(--gutter);
  padding-left: max(var(--gutter), env(safe-area-inset-left, 0px));
  padding-right: max(var(--gutter), env(safe-area-inset-right, 0px));
}
.app-nav__title {
  flex: 1;
  min-width: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.app-nav__title--detail {
  font-size: 19px;
  letter-spacing: 0;
}
.app-nav__actions {
  flex: 0 0 auto;
  margin-left: var(--space-3);
}
.app-nav__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  flex-shrink: 0;
  margin: 0 var(--space-3) 0 0;
  border: 0;
  border-radius: var(--radius-md);
  color: var(--text);
  background: var(--surface);
}
.app-nav__back::after {
  border: none;
}
.app-nav__pressed {
  background: var(--primary-soft);
}
.app-nav__chevron {
  width: 11px;
  height: 11px;
  border-left: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(45deg);
}
</style>
