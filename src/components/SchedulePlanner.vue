<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  confirmSchedule,
  previewSchedule,
  type ScheduleDraft,
  type WorkflowStep,
} from '@/services/workflow'
import { useAuthStore } from '@/store/auth'
import LocalDateTimeField from './LocalDateTimeField.vue'
import LoadingButton from './LoadingButton.vue'

const props = defineProps<{
  /** 当前用户，限定预览确认的写入范围。 */
  owner: string
  /** 要转换的想法。 */
  ideaId: string
  /** 当前步骤及其排序、时长和版本。 */
  steps: WorkflowStep[]
}>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const auth = useAuthStore()
const revision = auth.revision
const startAt = ref(Math.ceil(Date.now() / 60000) * 60000)
const drafts = ref<ScheduleDraft[]>([])
const saving = ref(false)
const error = ref('')
let mounted = true
onBeforeUnmount(() => {
  mounted = false
})

const stale = computed(
  () =>
    drafts.value.length > 0 &&
    (drafts.value.length !== props.steps.length ||
      drafts.value.some(
        (item, i) =>
          item.step_id !== props.steps[i]?.id ||
          item.step_version !== props.steps[i]?.updated_at,
      )),
)
const invalidTime = computed(() =>
  drafts.value.some((item) => item.end_at <= item.start_at),
)

function preview() {
  try {
    drafts.value = previewSchedule(props.steps, startAt.value)
    error.value = ''
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '请检查步骤和起始时间。'
  }
}

function resetPreview() {
  drafts.value = []
  error.value = ''
}

async function confirm() {
  if (
    saving.value ||
    !drafts.value.length ||
    stale.value ||
    invalidTime.value ||
    auth.user?.id !== props.owner ||
    auth.revision !== revision
  )
    return
  saving.value = true
  error.value = ''
  try {
    const warning = await confirmSchedule(
      props.owner,
      props.ideaId,
      drafts.value,
    )
    if (mounted && auth.revision === revision) {
      uni.showToast({ title: warning ?? '日程已保存', icon: 'none' })
      emit('saved')
    }
  } catch (cause) {
    if (mounted)
      error.value =
        cause instanceof Error ? cause.message : '日程保存失败，请重试。'
  } finally {
    if (mounted) saving.value = false
  }
}
</script>

<template>
  <view class="planner">
    <view class="planner-heading">
      <text class="planner-title">{{
        drafts.length ? '日程预览' : '一键转日程'
      }}</text>
      <button class="quiet-button" :disabled="saving" @click="emit('cancel')">
        取消
      </button>
    </view>
    <template v-if="drafts.length">
      <text class="muted-copy"
        >确认后写入日程，每条提醒设在开始前 10 分钟。</text
      >
      <view v-for="(item, i) in drafts" :key="item.id" class="draft">
        <text class="draft-title">{{ i + 1 }}. {{ item.title }}</text>
        <LocalDateTimeField
          v-model="item.start_at"
          label="开始"
          :disabled="saving"
        />
        <LocalDateTimeField
          v-model="item.end_at"
          label="结束"
          :disabled="saving"
        />
        <text
          v-if="item.end_at <= item.start_at"
          class="error-text"
          role="alert"
          >结束时间须晚于开始时间。</text
        >
      </view>
      <text v-if="stale" class="error-text" role="alert"
        >步骤已有变动，请重选起始时间并重新预览。</text
      >
      <button class="quiet-button" :disabled="saving" @click="resetPreview">
        重选起始时间
      </button>
      <text v-if="error" class="error-text" role="alert">{{ error }}</text>
      <LoadingButton
        :label="'确认写入 ' + drafts.length + ' 条日程'"
        :disabled="stale || invalidTime"
        :loading="saving"
        @click="confirm"
      />
    </template>
    <template v-else>
      <LocalDateTimeField v-model="startAt" label="起始时间" />
      <text v-if="error" class="error-text" role="alert">{{ error }}</text>
      <LoadingButton
        label="预览日程"
        variant="secondary"
        :disabled="!steps.length"
        @click="preview"
      />
    </template>
  </view>
</template>

<style scoped>
.planner {
  border-top: 1px solid var(--border);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
}
.planner-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.planner-title {
  font-size: 16px;
  font-weight: 650;
}
.draft {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
}
.draft-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.planner > .local-field {
  margin-bottom: var(--space-3);
}
</style>
