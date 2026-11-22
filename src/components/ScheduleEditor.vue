<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Idea } from '@/services/ideas'
import { repeatLabel, type ScheduleRow } from '@/services/calendar'
import type { ScheduleInput } from '@/services/schedules'
import { calendarDate } from '@/utils/localDateTime'
import LoadingButton from './LoadingButton.vue'
import LocalDateTimeField from './LocalDateTimeField.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{
  /** 编辑时提供原始日程，包括重复系列的首次时间。 */
  original?: ScheduleRow
  /** 新建日程时预填的日历日期。 */
  selectedAt: number
  /** 用于选择关联想法的未删除记录。 */
  ideas: Idea[]
  /** 想法选项是否正在读取。 */
  ideasLoading: boolean
  /** 想法读取失败时的提示。 */
  ideasError: string
  /** 保存或删除期间锁定表单。 */
  busy: boolean
  /** 日程写入失败时的提示。 */
  error: string
}>()
const emit = defineEmits<{
  save: [input: ScheduleInput]
  remove: []
  retryIdeas: []
}>()
const rules = [
  { label: '不重复', value: null },
  { label: '每天', value: 'FREQ=DAILY' },
  { label: '每周', value: 'FREQ=WEEKLY' },
  { label: '每月', value: 'FREQ=MONTHLY' },
]
const original = props.original
const base = new Date(props.selectedAt)
const now = new Date()
if (calendarDate(base.getTime()) === calendarDate(now.getTime()))
  base.setHours(now.getHours(), now.getMinutes(), 0, 0)
else base.setHours(9, 0, 0, 0)
const title = ref(original?.title ?? '')
const startAt = ref(original?.start_at ?? base.getTime())
const endAt = ref(original?.end_at ?? startAt.value + 30 * 60_000)
const priority = ref<0 | 1>(original?.priority ? 1 : 0)
const ideaId = ref(original?.idea_id ?? null)
const repeatRule = ref(original?.repeat_rule ?? null)
const options = computed(() => {
  const available = props.ideas.map((idea) => ({
    label: idea.content.replace(/\s+/g, ' ').slice(0, 60),
    value: idea.id as string | null,
  }))
  if (ideaId.value && !available.some((item) => item.value === ideaId.value))
    available.unshift({ label: '原关联想法', value: ideaId.value })
  return [{ label: '不关联想法', value: null }, ...available]
})
const ideaIndex = computed(() =>
  options.value.findIndex((item) => item.value === ideaId.value),
)
const ruleIndex = computed(() =>
  rules.findIndex((rule) => rule.label === repeatLabel(repeatRule.value)),
)
const deleteOpen = ref(false)
const invalidTime = computed(() => endAt.value <= startAt.value)
// TODO：支持“仅改本次”时，在这里增加编辑范围选择并记录实例例外。

function changeStart(value: number) {
  const duration = endAt.value - startAt.value
  startAt.value = value
  if (duration > 0) endAt.value = value + duration
}

function save() {
  if (props.busy || !title.value.trim() || invalidTime.value) return
  emit('save', {
    title: title.value.trim(),
    start_at: startAt.value,
    end_at: endAt.value,
    repeat_rule: repeatRule.value,
    priority: priority.value,
    idea_id: ideaId.value,
  })
}

function remove() {
  deleteOpen.value = false
  emit('remove')
}
</script>

<template>
  <view class="surface editor">
    <text v-if="original?.repeat_rule" class="series-note"
      >修改将应用于全部重复日程。下方起止时间为首次日程的时间。</text
    >
    <text class="label">标题</text>
    <input
      v-model="title"
      class="field title-input"
      aria-label="日程标题"
      placeholder="填写日程标题"
      :maxlength="-1"
      :disabled="busy"
    />
    <LocalDateTimeField
      label="开始"
      :model-value="startAt"
      :disabled="busy"
      @update:model-value="changeStart"
    />
    <LocalDateTimeField v-model="endAt" label="结束" :disabled="busy" />
    <text v-if="invalidTime" class="error-text" role="alert"
      >结束时间必须晚于开始时间。</text
    >
    <text class="label">重复</text>
    <picker
      mode="selector"
      :range="rules"
      range-key="label"
      :value="Math.max(0, ruleIndex)"
      :disabled="busy"
      @change="repeatRule = rules[Number($event.detail.value)].value"
    >
      <view class="field selector" role="button" aria-label="重复规则"
        ><text>{{ repeatLabel(repeatRule) }}</text
        ><text class="down">▾</text></view
      >
    </picker>
    <text class="label">优先级</text>
    <view class="priorities">
      <button
        class="priority"
        :class="{ active: !priority }"
        :aria-pressed="!priority"
        :disabled="busy"
        @click="priority = 0"
      >
        普通
      </button>
      <button
        class="priority"
        :class="{ active: priority }"
        :aria-pressed="!!priority"
        :disabled="busy"
        @click="priority = 1"
      >
        重要
      </button>
    </view>
    <text class="label">关联想法</text>
    <picker
      mode="selector"
      :range="options"
      range-key="label"
      :value="ideaIndex"
      :disabled="busy || ideasLoading || !!ideasError"
      @change="ideaId = options[Number($event.detail.value)].value"
    >
      <view class="field selector" role="button" aria-label="关联想法"
        ><text class="idea-name">{{
          ideasLoading ? '正在读取想法…' : options[ideaIndex]?.label
        }}</text
        ><text class="down">▾</text></view
      >
    </picker>
    <text
      v-if="original?.step_id && ideaId !== original.idea_id"
      class="muted-copy"
      >保存后将解除原流程步骤的关联。</text
    >
    <view v-if="ideasError" class="problem">
      <text class="error-text" role="alert">{{ ideasError }}</text><button
        class="quiet-button"
        @click="emit('retryIdeas')"
      >
        重新读取想法
      </button>
    </view>
    <text v-if="error" class="error-text" role="alert">{{ error }}</text>
    <LoadingButton
      :label="original?.repeat_rule ? '保存全部' : '保存日程'"
      loading-text="处理中…"
      :loading="busy"
      :disabled="!title.trim() || invalidTime"
      @click="save"
    />
    <button
      v-if="original"
      class="quiet-button remove"
      :disabled="busy"
      @click="deleteOpen = true"
    >
      {{ original.repeat_rule ? '删除全部重复日程' : '删除日程' }}
    </button>
    <ConfirmDialog
      :visible="deleteOpen"
      :busy="busy"
      :title="original?.repeat_rule ? '删除全部重复日程？' : '删除日程？'"
      :message="
        original?.repeat_rule
          ? '整组日程和对应提醒将一并删除。'
          : '这条日程和对应提醒将一并删除。'
      "
      confirm-text="删除"
      destructive
      @confirm="remove"
      @cancel="deleteOpen = false"
    />
  </view>
</template>

<style scoped>
.editor {
  padding: var(--space-4) var(--space-4) var(--space-3);
}
.series-note {
  display: block;
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 14px;
  line-height: 1.55;
}
.label {
  display: block;
  margin: var(--space-4) 0 var(--space-2);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 650;
}
.label:first-child {
  margin-top: 0;
}
.field,
.priority {
  box-sizing: border-box;
  min-height: 48px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text);
  font-size: 15px;
}
.title-input {
  width: 100%;
}
.selector,
.priorities {
  display: flex;
  align-items: center;
}
.selector {
  justify-content: space-between;
}
.priorities {
  gap: var(--space-2);
}
.idea-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.down {
  margin-left: var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
}
.priority {
  flex: 1;
  margin: 0;
  line-height: 46px;
}
.priority::after {
  border: 0;
}
.priority.active {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-soft);
  font-weight: 650;
}
.editor :deep(.loading-button) {
  margin-top: var(--space-5);
}
.error-text {
  margin-top: var(--space-3);
}
.remove {
  display: flex;
  margin: var(--space-2) auto 0;
  color: var(--danger);
}
</style>
