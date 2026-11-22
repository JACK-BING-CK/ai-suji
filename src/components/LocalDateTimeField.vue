<script setup lang="ts">
import { ref } from 'vue'
import { calendarDate, clockTime } from '@/utils/localDateTime'

const props = defineProps<{
  /** 以用户本地时区选择日期和时间。 */
  label: string
  /** UTC 毫秒时间戳。 */
  modelValue: number
  /** 写入期间锁定选择器。 */
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [number] }>()
const error = ref('')

function change(part: 'date' | 'time', value: string) {
  const day = part === 'date' ? value : calendarDate(props.modelValue)
  const time = part === 'time' ? value : clockTime(props.modelValue)
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const at = new Date(year, month - 1, date, hour, minute).getTime()
  if (calendarDate(at) !== day || clockTime(at) !== time) {
    error.value = '这个本地时间不存在，请重新选择。'
    return
  }
  error.value = ''
  emit('update:modelValue', at)
}
</script>

<template>
  <view class="local-field">
    <text class="label">{{ label }}</text>
    <view class="pickers">
      <picker
        mode="date"
        :value="calendarDate(modelValue)"
        :disabled="disabled"
        @change="change('date', String($event.detail.value))"
      >
        <view class="value" role="button" :aria-label="label + '日期'">{{
          calendarDate(modelValue)
        }}</view>
      </picker>
      <picker
        mode="time"
        :value="clockTime(modelValue)"
        :disabled="disabled"
        @change="change('time', String($event.detail.value))"
      >
        <view class="value" role="button" :aria-label="label + '时间'">{{
          clockTime(modelValue)
        }}</view>
      </picker>
    </view>
    <text v-if="error" class="error-text" role="alert">{{ error }}</text>
  </view>
</template>

<style scoped>
.local-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.label {
  flex: 0 0 auto;
  min-width: 38px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 650;
}
.pickers {
  display: flex;
  flex: 1 1 152px;
  gap: var(--space-2);
}
.pickers > :first-child {
  flex: 1;
  min-width: 0;
}
.value {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--space-3);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--primary);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.local-field > .error-text {
  flex: 0 0 100%;
  box-sizing: border-box;
}
</style>
