<script setup lang="ts">
interface Props {
  /** 说明当前没有哪一类内容。 */
  title: string
  /** 补充说明或下一步提示，可省略。 */
  description?: string
  /** 操作按钮的文字，省略时不显示按钮。 */
  actionText?: string
}

defineProps<Props>()
const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <view class="empty-state">
    <view class="empty-state__icon" aria-hidden="true">
      <view class="empty-state__paper">
        <view class="empty-state__line" />
        <view class="empty-state__line empty-state__line--short" />
      </view>
    </view>
    <text class="empty-state__title">{{ title }}</text>
    <text v-if="description" class="empty-state__description">{{
      description
    }}</text>
    <button
      v-if="actionText"
      class="empty-state__action"
      hover-class="empty-state__action--pressed"
      @click="emit('action')"
    >
      {{ actionText }}
    </button>
  </view>
</template>

<style scoped>
.empty-state {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-6) var(--space-4);
  text-align: center;
}
.empty-state__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--primary-soft);
  color: var(--primary);
}
.empty-state__paper {
  box-sizing: border-box;
  width: 24px;
  height: 29px;
  padding: 8px 4px 0;
  border: 1.5px solid currentColor;
  border-radius: 2px 5px 2px 2px;
  transform: rotate(-7deg);
}
.empty-state__line {
  height: 1.5px;
  margin-bottom: 4px;
  background: currentColor;
}
.empty-state__line--short {
  width: 65%;
}
.empty-state__title {
  color: var(--text);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
}
.empty-state__description {
  max-width: 360px;
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.65;
}
.empty-state__action {
  box-sizing: border-box;
  min-height: 44px;
  margin: var(--space-3) 0 0;
  padding: 10px var(--space-4);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--primary);
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.65;
}
.empty-state__action::after {
  border: none;
}
.empty-state__action--pressed {
  background: var(--primary-soft);
}
</style>
