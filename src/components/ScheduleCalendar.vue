<script setup lang="ts">
import { computed } from 'vue'
import type { CalendarDay, CalendarMode } from '@/services/calendar'
import { calendarDate } from '@/utils/localDateTime'

const props = defineProps<{
  /** 已按本地时区生成的日历格，包括跨月补齐的日期。 */
  days: CalendarDay[]
  /** 当前选中日期的毫秒时间戳。 */
  selectedAt: number
  /** 当前展示的周或月。 */
  mode: CalendarMode
  /** 当前展示周期的标题。 */
  heading: string
}>()
const emit = defineEmits<{
  select: [date: number]
  move: [offset: number]
  mode: [value: CalendarMode]
  today: []
}>()
const selectedKey = computed(() => calendarDate(props.selectedAt))
const weekdays = ['一', '二', '三', '四', '五', '六', '日']

function jumpTo(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  emit('select', new Date(year, month - 1, day).getTime())
}
</script>

<template>
  <view class="surface calendar">
    <view class="calendar-heading">
      <picker
        class="period-picker"
        mode="date"
        :value="selectedKey"
        @change="jumpTo(String($event.detail.value))"
      >
        <view class="period" role="button" :aria-label="heading + '，跳转日期'">
          <text>{{ heading }}</text>
          <text class="picker-arrow" aria-hidden="true">▾</text>
        </view>
      </picker>
      <view class="arrows">
        <button
          class="quiet-button arrow"
          :aria-label="mode === 'month' ? '上个月' : '上一周'"
          @click="emit('move', -1)"
        >
          <view class="chevron previous" aria-hidden="true" />
        </button>
        <button
          class="quiet-button arrow"
          :aria-label="mode === 'month' ? '下个月' : '下一周'"
          @click="emit('move', 1)"
        >
          <view class="chevron next" aria-hidden="true" />
        </button>
      </view>
    </view>
    <view class="calendar-tools">
      <view class="mode-switch" aria-label="日历视图">
        <button
          class="mode"
          :class="{ active: mode === 'month' }"
          :aria-pressed="mode === 'month'"
          @click="emit('mode', 'month')"
        >
          月视图
        </button>
        <button
          class="mode"
          :class="{ active: mode === 'week' }"
          :aria-pressed="mode === 'week'"
          @click="emit('mode', 'week')"
        >
          周视图
        </button>
      </view>
      <button class="quiet-button today-action" @click="emit('today')">
        回到今天
      </button>
    </view>
    <view class="dates">
      <text v-for="day in weekdays" :key="day" class="weekday">{{ day }}</text>
      <button
        v-for="day in days"
        :key="day.date"
        class="day"
        hover-class="day-pressed"
        :class="{
          outside: !day.inMonth,
          today: day.isToday,
          selected: calendarDate(day.date) === selectedKey,
        }"
        :aria-label="
          calendarDate(day.date) +
          (day.isToday ? '，今天' : '') +
          (day.hasSchedules ? '，有日程' : '')
        "
        :aria-pressed="calendarDate(day.date) === selectedKey"
        @click="emit('select', day.date)"
      >
        <view class="day-face">
          <text>{{ day.number }}</text>
          <view v-if="day.hasSchedules" class="dot" aria-hidden="true" />
        </view>
      </button>
    </view>
  </view>
</template>

<style scoped>
.calendar {
  padding: 10px var(--space-3) var(--space-2);
}
.calendar-tools,
.calendar-heading,
.mode-switch,
.arrows {
  display: flex;
  align-items: center;
}
.calendar-tools,
.calendar-heading {
  justify-content: space-between;
}
.calendar-heading {
  gap: var(--space-2);
  padding-bottom: 6px;
}
.calendar-tools {
  margin-bottom: var(--space-2);
}
.mode-switch {
  gap: 2px;
  padding: 2px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.mode {
  min-height: 44px;
  margin: 0;
  padding: 0 var(--space-3);
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 44px;
}
.mode::after,
.day::after {
  border: 0;
}
.mode.active {
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 700;
}
.day.selected .day-face {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
  font-weight: 700;
}
.period-picker {
  min-width: 0;
}
.period {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
}
.picker-arrow {
  flex: 0 0 auto;
  margin-left: 5px;
  color: var(--text-muted);
  font-size: 13px;
}
.arrows {
  flex: 0 0 auto;
  gap: 2px;
}
.arrow {
  min-width: 44px;
  min-height: 44px;
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.chevron {
  width: 8px;
  height: 8px;
  border: solid currentColor;
  border-width: 1.5px 1.5px 0 0;
}
.previous {
  transform: rotate(-135deg);
}
.next {
  transform: rotate(45deg);
}
.today-action {
  padding-right: 0;
  white-space: nowrap;
}
.dates {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.weekday {
  padding: 6px 0;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.day {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 44px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.day-face {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: min(36px, 100%);
  height: 36px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}
.outside {
  color: var(--text-muted);
}
.day.today .day-face {
  border-color: var(--primary);
  font-weight: 700;
}
.day.today:not(.selected) .day-face,
.day-pressed:not(.selected) .day-face {
  background: var(--primary-soft);
  color: var(--primary);
}
.dot {
  position: absolute;
  left: 50%;
  bottom: 4px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: var(--primary);
}
.selected .dot {
  background: var(--on-primary);
}
</style>
