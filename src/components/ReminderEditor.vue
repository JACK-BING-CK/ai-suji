<script setup lang="ts">
import { computed, ref } from 'vue'
import LocalDateTimeField from './LocalDateTimeField.vue'
import LoadingButton from './LoadingButton.vue'
import type { saveReminderSettings } from '@/services/reminderService'

type Input = Parameters<typeof saveReminderSettings>[2]
const props = defineProps<{
  /** 已有提醒的设置；新建时传入选中日程的建议时间。 */
  initial: Input
  /** 保存过程中锁定表单。 */
  busy: boolean
  /** 在 iOS 客户端中说明系统通知铃声时长限制。 */
  ios: boolean
}>()
const emit = defineEmits<{ save: [input: Input]; cancel: [] }>()
const level = ref(props.initial.level)
const remindAt = ref(props.initial.remind_at)
const minutes = ref(String(props.initial.snooze_min))
const error = ref('')
const validMinutes = computed(
  () =>
    /^\d+$/.test(minutes.value) &&
    Number.isSafeInteger(Number(minutes.value)) &&
    Number(minutes.value) > 0 &&
    Number(minutes.value) <= 2147483647,
)

function submit() {
  if (props.busy) return
  if (remindAt.value <= Date.now()) {
    error.value = '请选择晚于现在的提醒时间。'
    return
  }
  if (!validMinutes.value) {
    error.value = '稍后提醒的分钟数须为正整数。'
    return
  }
  error.value = ''
  emit('save', {
    ...props.initial,
    level: level.value,
    remind_at: remindAt.value,
    snooze_min: Number(minutes.value),
    enabled: 1,
  })
}
</script>
<template>
  <view class="editor">
    <text class="section-title">{{
      initial.id ? '编辑提醒' : '添加提醒'
    }}</text>
    <view class="levels" aria-label="提醒方式">
      <button
        class="level"
        :class="{ selected: level === 0 }"
        :aria-pressed="level === 0"
        :disabled="busy"
        @click="level = 0"
      >
        通知
      </button>
      <button
        class="level"
        :class="{ selected: level === 1 }"
        :aria-pressed="level === 1"
        :disabled="busy"
        @click="level = 1"
      >
        闹钟
      </button>
    </view>
    <text v-if="level === 1 && ios" class="muted-copy"
      >iOS 闹钟使用本地通知。系统的自定义铃声上限为 30 秒，音频须短于 30
      秒，播放一次即结束。</text
    >
    <text v-else-if="level === 1" class="muted-copy"
      >系统限制锁屏全屏时，闹钟仍会按时发通知。声音和震动取决于通知设置，点开通知可完成或延期。</text
    >
    <LocalDateTimeField label="提醒时间" v-model="remindAt" :disabled="busy" />
    <view v-if="level === 1" class="minutes">
      <text>稍后提醒</text>
      <input
        v-model="minutes"
        type="number"
        aria-label="稍后提醒分钟数"
        :disabled="busy"
      />
      <text>分钟后</text>
    </view>
    <text v-if="error" class="error-text" role="alert">{{ error }}</text>
    <view class="actions">
      <button class="quiet-button" :disabled="busy" @click="emit('cancel')">
        取消
      </button>
      <LoadingButton
        :label="initial.enabled ? '保存提醒' : '保存并开启'"
        :loading="busy"
        @click="submit"
      />
    </view>
  </view>
</template>
<style scoped>
.editor {
  margin: var(--space-2) var(--space-3) var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
}
.levels,
.actions,
.minutes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.level {
  flex: 1;
  margin: 0;
  min-width: 76px;
  min-height: 44px;
  padding: 0 var(--space-3);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 15px;
  line-height: 42px;
}
.level::after {
  border: 0;
}
.level.selected {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: var(--primary);
  font-weight: 600;
}
.minutes {
  color: var(--text-secondary);
  font-size: 14px;
}
.minutes input {
  min-height: 44px;
  width: 66px;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
}
.actions {
  justify-content: flex-end;
}
.actions :deep(.loading-button) {
  width: auto;
  max-width: 100%;
  min-width: 110px;
}
.error-text {
  margin-top: var(--space-3);
}
</style>
