<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkflowStep } from '@/services/workflow'

const props = defineProps<{
  /** 当前持久化顺序。 */
  steps: WorkflowStep[]
  /** 上次排序提交时锁定拖动。 */
  disabled: boolean
}>()
const emit = defineEmits<{ reorder: [ids: string[]] }>()
const rowHeight = 56
const from = ref(-1)
const offset = ref(0)
let originY = 0
const target = computed(() => from.value + Math.round(offset.value / rowHeight))
const positions = computed(() =>
  props.steps.map((_, i) => '第 ' + (i + 1) + ' 步'),
)

function start(index: number, event: TouchEvent) {
  if (props.disabled || event.touches.length !== 1) return
  originY = event.touches[0].clientY
  offset.value = 0
  from.value = index
}

function move(y: number) {
  if (from.value < 0) return
  offset.value = Math.min(
    (props.steps.length - 1 - from.value) * rowHeight,
    Math.max(-from.value * rowHeight, y - originY),
  )
}

function place(index: number, to: number) {
  if (
    props.disabled ||
    index === to ||
    index < 0 ||
    to < 0 ||
    to >= props.steps.length
  )
    return
  const ids = props.steps.map((step) => step.id)
  ids.splice(to, 0, ...ids.splice(index, 1))
  emit('reorder', ids)
}

function finish(event: TouchEvent) {
  if (from.value < 0) return
  if (event.changedTouches[0]) move(event.changedTouches[0].clientY)
  place(from.value, target.value)
  from.value = -1
}

function shift(index: number) {
  if (from.value === index) return offset.value
  if (from.value >= 0 && index > from.value && index <= target.value)
    return -rowHeight
  if (index < from.value && index >= target.value) return rowHeight
  return 0
}

watch(
  () => props.steps.map((step) => step.id).join(','),
  () => {
    from.value = -1
  },
)
</script>

<template>
  <view class="order-list">
    <text class="muted-copy">拖动右侧手柄调整顺序，也可以点序号选择位置。</text>
    <view
      v-for="(step, index) in steps"
      :key="step.id"
      class="order-row"
      :class="{ moving: from === index }"
      :style="{
        height: rowHeight + 'px',
        transform: 'translateY(' + shift(index) + 'px)',
      }"
    >
      <picker
        mode="selector"
        :value="index"
        :range="positions"
        :disabled="disabled"
        @change="place(index, Number($event.detail.value))"
      >
        <view
          class="position"
          role="button"
          :aria-label="'调整' + step.title + '的位置'"
          >{{ index + 1 }}</view
        >
      </picker>
      <text class="title">{{ step.title }}</text>
      <view
        class="handle"
        :aria-label="'拖动' + step.title"
        @touchstart.stop="start(index, $event)"
        @touchmove.stop.prevent="
          from >= 0 && $event.touches[0] && move($event.touches[0].clientY)
        "
        @touchend.stop="finish"
        @touchcancel="from = -1"
      >
        <view class="grip" aria-hidden="true" />
      </view>
    </view>
  </view>
</template>

<style scoped>
.order-list {
  padding-bottom: var(--space-2);
}
.order-list .muted-copy {
  margin-bottom: var(--space-2);
}
.order-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  position: relative;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  transition: transform 0.12s ease;
}
.moving {
  z-index: 1;
  background: var(--primary-soft);
  border-radius: var(--radius-sm);
  transition: none;
}
.position,
.handle {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 48px;
  color: var(--primary);
}
.position {
  font-size: 14px;
  font-weight: 650;
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 15px;
}
.handle {
  flex: 0 0 48px;
  touch-action: none;
  user-select: none;
}
.grip {
  width: 16px;
  height: 5px;
  border-top: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
}
</style>
