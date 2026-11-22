<script setup lang="ts">
import { computed, ref } from 'vue'
import type { StepInput } from '@/services/workflow'
import LoadingButton from './LoadingButton.vue'

const props = defineProps<{
  /** 编辑已有步骤时用其字段填充，新增时为空。 */
  initial?: StepInput
  /** 防止重复提交。 */
  saving: boolean
}>()
const emit = defineEmits<{ save: [input: StepInput]; cancel: [] }>()
const title = ref(props.initial?.title ?? '')
const detail = ref(props.initial?.detail ?? '')
const duration = ref(String(props.initial?.duration_min ?? 30))
const validMinutes = computed(
  () =>
    /^\d+$/.test(duration.value) &&
    Number.isSafeInteger(Number(duration.value)) &&
    Number(duration.value) > 0,
)

function submit() {
  if (!props.saving && title.value.trim() && validMinutes.value)
    emit('save', {
      title: title.value.trim(),
      detail: detail.value.trim(),
      duration_min: Number(duration.value),
    })
}
</script>

<template>
  <view class="editor">
    <text class="editor-label">步骤标题</text>
    <input
      v-model="title"
      class="input"
      aria-label="步骤标题"
      placeholder="填写要完成的事"
      :maxlength="-1"
      :disabled="saving"
    />
    <text class="editor-label">说明</text>
    <textarea
      v-model="detail"
      class="input description"
      aria-label="步骤说明"
      placeholder="可选"
      :maxlength="-1"
      :disabled="saving"
    />
    <text class="editor-label">预计时长（分钟）</text>
    <input
      v-model="duration"
      class="input"
      type="number"
      aria-label="预计时长（分钟）"
      :disabled="saving"
    />
    <text v-if="!validMinutes" class="error-text" role="alert"
      >时长须为大于零的整数。</text
    >
    <view class="actions">
      <button class="quiet-button" :disabled="saving" @click="emit('cancel')">
        取消
      </button>
      <LoadingButton
        label="保存步骤"
        :loading="saving"
        :disabled="!title.trim() || !validMinutes"
        @click="submit"
      />
    </view>
  </view>
</template>

<style scoped>
.editor {
  margin: var(--space-2) 0;
}
.editor-label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin: var(--space-2) 0 var(--space-1);
}
.input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2);
  min-height: 42px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
.description {
  height: 74px;
}
.actions {
  display: flex;
  align-items: center;
  margin-top: var(--space-3);
}
.actions .quiet-button {
  margin-right: var(--space-2);
}
</style>
