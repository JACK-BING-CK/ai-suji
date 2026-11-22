<script setup lang="ts">
interface Props {
  /** 按钮在空闲时显示的操作名称。 */
  label: string
  /** 正在执行操作时显示进度，并阻止再次点击。 */
  loading?: boolean
  /** 即使未加载也禁止点击。 */
  disabled?: boolean
  /** 加载时显示的文字。 */
  loadingText?: string
  /** 主操作、次操作或危险操作的配色。 */
  variant?: 'primary' | 'secondary' | 'danger'
}

const props = withDefaults(defineProps<Props>(), {
  loadingText: '处理中…',
  variant: 'primary',
})
const emit = defineEmits<{ click: [] }>()

function activate() {
  if (!props.disabled && !props.loading) emit('click')
}
</script>

<template>
  <button
    class="loading-button"
    :class="[
      'loading-button--' + variant,
      { 'loading-button--disabled': disabled && !loading },
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading"
    hover-class="loading-button--pressed"
    @click="activate"
  >
    <view v-if="loading" class="loading-button__spinner" aria-hidden="true" />
    <text>{{ loading ? loadingText : label }}</text>
  </button>
</template>

<style scoped>
.loading-button {
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 48px;
  width: 100%;
  margin: 0;
  padding: 10px 18px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.loading-button::after {
  border: none;
}
.loading-button--primary,
.loading-button--primary[disabled] {
  color: var(--on-primary);
  background: var(--primary);
}
.loading-button--secondary,
.loading-button--secondary[disabled] {
  color: var(--primary);
  background: var(--surface);
  border-color: var(--border);
}
.loading-button--danger,
.loading-button--danger[disabled] {
  color: var(--danger);
  background: var(--danger-soft);
}
.loading-button--disabled {
  opacity: 0.7;
}
.loading-button--primary.loading-button--disabled {
  color: var(--text-muted);
  background: var(--primary-soft);
  border-color: var(--border);
}
.loading-button--pressed {
  opacity: 0.84;
}
.loading-button__spinner {
  box-sizing: border-box;
  flex: 0 0 15px;
  width: 15px;
  height: 15px;
  margin-right: 8px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: loading-turn 0.7s linear infinite;
}
@keyframes loading-turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loading-button__spinner {
    animation: none;
  }
}
</style>
