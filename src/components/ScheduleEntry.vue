<script setup lang="ts">
import { computed } from 'vue'
import { repeatLabel, type ScheduleOccurrence } from '@/services/calendar'
import { calendarDate, clockTime, timeRange } from '@/utils/localDateTime'
import DoneToggle from './DoneToggle.vue'

const props = defineProps<{
  /** 对应日期的实例，时间和完成状态已经展开。 */
  item: ScheduleOccurrence
  /** 今日待办中标红已经结束的未完成实例。 */
  highlightOverdue?: boolean
  /** 写入期间锁定操作。 */
  busy: boolean
}>()
const emit = defineEmits<{ edit: []; toggle: [] }>()
const timeLabel = computed(() => {
  const { start_at: start, end_at: end } = props.item
  const year = new Date(start).getFullYear()
  if (
    year !== new Date(end).getFullYear() ||
    (props.highlightOverdue && year !== new Date().getFullYear())
  ) {
    const endDay =
      calendarDate(start) === calendarDate(end) ? '' : calendarDate(end) + ' '
    return (
      calendarDate(start) +
      ' ' +
      clockTime(start) +
      ' – ' +
      endDay +
      clockTime(end)
    )
  }
  return timeRange(start, end)
})

function navigationFailed() {
  uni.showToast({ title: '详情页打开失败，请重试', icon: 'none' })
}
</script>

<template>
  <view class="entry" :class="{ overdue: highlightOverdue && item.overdue }">
    <DoneToggle
      :title="item.schedule.title"
      :checked="item.done"
      :disabled="busy"
      @change="emit('toggle')"
    />
    <view class="entry-main">
      <button
        class="open-entry"
        role="button"
        :disabled="busy"
        :aria-label="'编辑日程，' + item.schedule.title"
        @click="emit('edit')"
      >
        <view class="entry-info">
          <text class="entry-name" :class="{ finished: item.done }">{{
            item.schedule.title
          }}</text>
          <text class="entry-time">{{ timeLabel }}</text>
          <view
            v-if="
              (highlightOverdue && item.overdue) ||
              item.schedule.priority ||
              item.schedule.repeat_rule
            "
            class="entry-status"
          >
            <text v-if="highlightOverdue && item.overdue" class="late"
              >已逾期</text
            >
            <text v-if="item.schedule.priority">重要</text>
            <text v-if="item.schedule.repeat_rule">{{
              repeatLabel(item.schedule.repeat_rule)
            }}</text>
          </view>
        </view>
        <text class="entry-chevron" aria-hidden="true">›</text>
      </button>
      <view class="entry-links">
        <navigator
          class="entry-link"
          :url="
            '/pages/schedule/detail?id=' +
            encodeURIComponent(item.schedule.id) +
            '&at=' +
            item.start_at
          "
          @fail="navigationFailed"
          >详情与提醒 ›</navigator
        >
        <navigator
          v-if="item.schedule.idea_id"
          class="entry-link"
          :url="
            '/pages/ideas/detail?id=' +
            encodeURIComponent(item.schedule.idea_id)
          "
          @fail="navigationFailed"
          >查看关联想法 ›</navigator
        >
      </view>
    </view>
  </view>
</template>

<style scoped>
.entry {
  display: flex;
  align-items: flex-start;
  box-sizing: border-box;
  padding: 7px var(--space-4) 3px var(--space-2);
}
.entry + .entry {
  border-top: 1px solid var(--border);
}
.entry-main,
.entry-info {
  flex: 1;
  min-width: 0;
}
.open-entry {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  margin: 0;
  padding: 7px 0 0;
  background: transparent;
  text-align: left;
  color: var(--text);
  line-height: 1.5;
}
.open-entry::after {
  border: 0;
}
.entry-name,
.entry-time {
  display: block;
}
.entry-name {
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.entry-time {
  margin-top: 3px;
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.entry-chevron {
  margin-left: var(--space-2);
  color: var(--text-muted);
  font-size: 20px;
}
.entry-status {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
  color: var(--primary);
  font-size: 12px;
}
.entry-status text {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--primary-soft);
}
.entry-status .late {
  color: var(--danger);
  background: var(--danger-soft);
}
.overdue .entry-time {
  color: var(--danger);
}
.finished {
  color: var(--text-muted);
  text-decoration: line-through;
}
.entry-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-3);
}
.entry-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
}
</style>
