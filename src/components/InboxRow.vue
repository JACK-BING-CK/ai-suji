<script setup lang="ts">
import { computed } from 'vue'
import type { Idea } from '@/services/library'

const props = defineProps<{
  /** 当前收集箱里的想法。 */
  item: Idea
  /** 左滑后显示删除操作。 */
  open: boolean
  /** 删除提交期间阻止重复操作。 */
  deleting: boolean
}>()
const emit = defineEmits<{ reveal: [open: boolean]; detail: []; remove: [] }>()

const date = computed(() => {
  const d = new Date(props.item.created_at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
})
const sourceNames = {
  text: '文字',
  voice: '语音',
  photo: '照片',
  share: '分享',
}
let startPoint: { clientX: number; clientY: number } | undefined
let swiped = false

function touchStart(event: TouchEvent) {
  startPoint = event.touches[0]
  swiped = false
}
function touchEnd(event: TouchEvent) {
  const end = event.changedTouches[0]
  if (!end || !startPoint) return
  const dx = end.clientX - startPoint.clientX
  const dy = end.clientY - startPoint.clientY
  startPoint = undefined
  if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.4) return
  swiped = true
  emit('reveal', dx < 0)
}
function activate() {
  if (swiped || props.deleting) return
  if (props.open) emit('reveal', false)
  else emit('detail')
}
</script>

<template>
  <view class="inbox-row">
    <button
      v-if="open"
      class="inbox-delete"
      :disabled="deleting"
      @click="emit('remove')"
    >
      {{ deleting ? '删除中' : '删除' }}
    </button>
    <button
      class="inbox-item"
      :class="{ 'inbox-item--open': open }"
      hover-class="inbox-item--pressed"
      @touchstart="touchStart"
      @touchend="touchEnd"
      @touchcancel="startPoint = undefined"
      @click="activate"
    >
      <view class="inbox-copy">
        <text class="inbox-content">{{ item.content }}</text>
        <view class="inbox-meta">
          <text class="inbox-source">{{ sourceNames[item.source] }}</text>
          <text>{{ date }}</text>
        </view>
      </view>
      <view class="inbox-chevron" aria-hidden="true" />
    </button>
  </view>
</template>

<style scoped>
.inbox-row {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.inbox-item,
.inbox-delete {
  border: 0;
  border-radius: 0;
  margin: 0;
}
.inbox-item::after,
.inbox-delete::after {
  border: 0;
}
.inbox-item {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: var(--space-4);
  text-align: left;
  background: var(--surface);
  color: var(--text);
  touch-action: pan-y;
  transition: transform 160ms ease-out;
}
.inbox-copy {
  flex: 1;
  min-width: 0;
}
.inbox-chevron {
  flex: none;
  width: 7px;
  height: 7px;
  margin-right: 4px;
  border-top: 1.5px solid var(--text-muted);
  border-right: 1.5px solid var(--text-muted);
  transform: rotate(45deg);
}
.inbox-item--open {
  transform: translateX(-76px);
}
.inbox-item--pressed {
  background: var(--primary-soft);
}
.inbox-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  margin-top: var(--space-2);
}
.inbox-source {
  padding: 1px 7px;
  border-radius: 99px;
  color: var(--primary);
  background: var(--primary-soft);
}
.inbox-content {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.55;
}
.inbox-delete {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 76px;
  padding: 0;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 15px;
}
@media (prefers-reduced-motion: reduce) {
  .inbox-item {
    transition: none;
  }
}
</style>
