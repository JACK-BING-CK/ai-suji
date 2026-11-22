<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

interface Props {
  /** 设为 true 时打开弹窗，处理 confirm 或 cancel 后复位为 false。 */
  visible: boolean
  /** 弹窗标题，概括需要确认的操作。 */
  title: string
  /** 说明确认操作的影响。 */
  message: string
  /** 确认按钮的文字。 */
  confirmText?: string
  /** 取消按钮的文字。 */
  cancelText?: string
  /** 标记危险操作，在支持按钮配色的平台使用警示色。 */
  destructive?: boolean
  /** 上一次操作仍在处理时，阻止再次打开确认框。 */
  busy?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  confirmText: '确定',
  cancelText: '取消',
})
const emit = defineEmits<{ confirm: []; cancel: [] }>()
let open = false
let mounted = true
onBeforeUnmount(() => {
  mounted = false
})

async function openDialog(visible: boolean) {
  if (!visible || open) return
  open = true
  try {
    // App 使用原生弹窗，确认期间底部原生 Tab 也会被遮罩。
    const result = await uni.showModal({
      title: props.title,
      content: props.message,
      confirmText: props.confirmText,
      cancelText: props.cancelText,
      confirmColor: props.destructive ? '#b7473d' : '#24796d',
    })
    if (mounted && props.visible && !props.busy) {
      if (result.confirm) emit('confirm')
      else emit('cancel')
    }
  } catch {
    if (mounted && props.visible) {
      uni.showToast({ title: '确认框打开失败，请重试', icon: 'none' })
      emit('cancel')
    }
  } finally {
    open = false
  }
}

watch(() => props.visible && !props.busy, openDialog, { immediate: true })
</script>

<template>
  <view v-if="false" />
</template>
