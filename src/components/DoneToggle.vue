<script setup lang="ts">
defineProps<{
  /** 对应步骤或日程的标题，供读屏识别。 */
  title: string
  /** 当前完成状态。 */
  checked: boolean
  /** 保存期间阻止重复勾选。 */
  disabled?: boolean
}>()
const emit = defineEmits<{ change: [] }>()
</script>

<template>
  <button
    class="done-toggle"
    role="checkbox"
    :aria-label="title + '，' + (checked ? '已完成' : '未完成')"
    :aria-checked="checked"
    :disabled="disabled"
    @click="emit('change')"
  >
    <view class="box" :class="{ checked }" aria-hidden="true">
      <text v-if="checked">✓</text>
    </view>
  </button>
</template>

<style scoped>
.done-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 44px;
  height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}
.done-toggle::after {
  border: 0;
}
.box {
  box-sizing: border-box;
  width: 22px;
  height: 22px;
  border: 1.5px solid var(--text-muted);
  border-radius: 7px;
  background: var(--surface);
  text-align: center;
  font-size: 15px;
  font-weight: 700;
  line-height: 19px;
}
.checked {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--on-primary);
}
</style>
