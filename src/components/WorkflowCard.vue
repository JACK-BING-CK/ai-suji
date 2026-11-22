<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { generateBreakdown } from '@/services/breakdown'
import { syncedDataRevision } from '@/services/sync'
import { reminderRevision } from '@/services/reminderService'
import {
  addStep,
  editStep,
  listIdeaSchedules,
  listSteps,
  removeStep,
  reorderSteps,
  setScheduleDone,
  setStepDone,
  type StepInput,
  type WorkflowStep,
} from '@/services/workflow'
import { useAuthStore } from '@/store/auth'
import { timeRange } from '@/utils/localDateTime'
import ConfirmDialog from './ConfirmDialog.vue'
import DoneToggle from './DoneToggle.vue'
import LoadingButton from './LoadingButton.vue'
import SchedulePlanner from './SchedulePlanner.vue'
import StepEditor from './StepEditor.vue'
import StepOrder from './StepOrder.vue'

const props = defineProps<{
  /** 当前想法的本地用户。 */
  owner: string
  /** 当前想法编号。 */
  ideaId: string
  /** 原文编辑中须先保存才能发起拆解。 */
  editingOriginal: boolean
  /** 详情页重新可见时更新。 */
  visible: boolean
}>()
const auth = useAuthStore()
const session = auth.revision
const steps = shallowRef<WorkflowStep[]>([])
type Schedule = Awaited<ReturnType<typeof listIdeaSchedules>>[number]
const schedules = shallowRef<Schedule[]>([])
const mode = ref<'view' | 'order' | 'plan'>('view')
const editor = ref<string | null>(null)
const deleting = shallowRef<WorkflowStep | null>(null)
const operation = ref('')
const readError = ref('')
const actionError = ref('')
const ready = ref(false)
const busy = computed(() => Boolean(operation.value))
const canEdit = computed(
  () => !busy.value && !editor.value && mode.value === 'view',
)
let mounted = true
let readVersion = 0

function current() {
  return mounted && auth.user?.id === props.owner && auth.revision === session
}

async function refresh() {
  if (!current() || !props.visible) return
  const version = ++readVersion
  try {
    const [flow, calendar] = await Promise.all([
      listSteps(props.owner, props.ideaId),
      listIdeaSchedules(props.owner, props.ideaId),
    ])
    if (!current() || version !== readVersion) return
    steps.value = flow
    schedules.value = calendar
    readError.value = ''
    ready.value = true
    if (
      editor.value &&
      editor.value !== 'new' &&
      !flow.some((item) => item.id === editor.value)
    )
      editor.value = null
    if (mode.value === 'order' && flow.length < 2) mode.value = 'view'
  } catch (cause) {
    if (current() && version === readVersion)
      readError.value =
        cause instanceof Error ? cause.message : '读取流程和日程失败，请重试。'
  }
}

onMounted(refresh)
watch([syncedDataRevision, reminderRevision, () => props.visible], refresh)
onBeforeUnmount(() => {
  mounted = false
})

async function run(name: string, action: () => Promise<unknown>) {
  if (busy.value || !current()) return
  operation.value = name
  actionError.value = ''
  try {
    await action()
    if (!current()) return
    if (name === 'save') editor.value = null
    await refresh()
  } catch (cause) {
    if (current())
      actionError.value =
        cause instanceof Error ? cause.message : '操作失败，请重试。'
  } finally {
    if (current()) operation.value = ''
  }
}

function save(input: StepInput) {
  const id = editor.value
  if (id)
    void run('save', () =>
      id === 'new'
        ? addStep(props.owner, props.ideaId, input)
        : editStep(props.owner, id, input),
    )
}

function confirmRemove() {
  const step = deleting.value
  deleting.value = null
  if (step) void run('remove', () => removeStep(props.owner, step.id))
}

function startEdit(id: string) {
  editor.value = id
  actionError.value = ''
}

function startPlan() {
  mode.value = 'plan'
  actionError.value = ''
}

function reorder(ids: string[]) {
  return run('order', () => reorderSteps(props.owner, props.ideaId, ids))
}

function toggleStep(step: WorkflowStep) {
  return run('done', () => setStepDone(props.owner, step.id, !step.done))
}

function toggleSchedule(item: Schedule) {
  return run('scheduleDone', () =>
    setScheduleDone(props.owner, item.id, !item.done),
  )
}

function generate() {
  return run('generate', () => generateBreakdown(props.owner, props.ideaId))
}

function finishPlan() {
  mode.value = 'view'
  void refresh()
}
</script>

<template>
  <view class="workflow">
    <view class="surface card">
      <view class="header">
        <text class="section-title">流程</text>
        <button
          v-if="mode === 'view'"
          class="quiet-button add-step"
          :disabled="!canEdit"
          @click="startEdit('new')"
        >
          添加步骤
        </button>
        <button
          v-else-if="mode === 'order'"
          class="quiet-button"
          :disabled="busy"
          @click="mode = 'view'"
        >
          完成排序
        </button>
      </view>
      <view v-if="readError" class="error-text" role="alert">
        <text>{{ readError }}</text><button
          class="quiet-button"
          @click="refresh"
        >
          重新读取
        </button>
      </view>
      <text v-else-if="!ready" class="muted-copy">正在读取步骤…</text>
      <StepEditor
        v-if="editor === 'new'"
        key="new"
        :saving="busy"
        @cancel="editor = null"
        @save="save"
      />
      <StepOrder
        v-if="mode === 'order'"
        :steps="steps"
        :disabled="busy"
        @reorder="reorder"
      />
      <template v-else>
        <text v-if="ready && !steps.length && !editor" class="muted-copy"
          >暂无流程步骤</text
        >
        <view v-for="(step, i) in steps" :key="step.id" class="step">
          <view class="item-head">
            <DoneToggle
              :title="step.title"
              :checked="Boolean(step.done)"
              :disabled="!canEdit"
              @change="toggleStep(step)"
            />
            <text class="item-title" :class="{ done: step.done }"
              >{{ i + 1 }}. {{ step.title }}</text
            >
          </view>
          <text class="duration">{{ step.duration_min }} 分钟</text>
          <text v-if="step.detail && editor !== step.id" class="detail">{{
            step.detail
          }}</text>
          <StepEditor
            v-if="editor === step.id"
            :initial="step"
            :saving="busy"
            @cancel="editor = null"
            @save="save"
          />
          <view v-else-if="mode === 'view'" class="row-tools">
            <button
              class="quiet-button"
              :disabled="!canEdit"
              @click="startEdit(step.id)"
            >
              编辑
            </button>
            <button
              class="quiet-button remove"
              :disabled="!canEdit"
              @click="deleting = step"
            >
              删除
            </button>
          </view>
        </view>
      </template>
      <text v-if="actionError" class="error-text" role="alert">{{
        actionError
      }}</text>
      <template v-if="mode === 'view' && !editor && ready">
        <view v-if="steps.length" class="toolbar">
          <button
            v-if="steps.length > 1"
            class="quiet-button"
            :disabled="busy"
            @click="mode = 'order'"
          >
            调整顺序
          </button>
          <button
            class="quiet-button plan-action"
            :disabled="busy"
            @click="startPlan"
          >
            一键转日程
          </button>
        </view>
        <text v-if="editingOriginal && auth.token" class="muted-copy"
          >保存原文后即可拆解。</text
        >
        <LoadingButton
          v-if="auth.token"
          :label="steps.length ? '用 AI 追加步骤' : '用 AI 拆解步骤'"
          :variant="steps.length ? 'secondary' : 'primary'"
          :disabled="editingOriginal || busy"
          :loading="operation === 'generate'"
          loading-text="正在拆解步骤…"
          @click="generate"
        />
        <navigator v-else class="quiet-button" url="/pages/auth/login"
          >登录后使用 AI 拆解</navigator
        >
      </template>
      <SchedulePlanner
        v-if="mode === 'plan'"
        :steps="steps"
        :owner="owner"
        :idea-id="ideaId"
        @cancel="mode = 'view'"
        @saved="finishPlan"
      />
    </view>
    <view class="surface card">
      <text class="section-title">关联日程</text>
      <text v-if="ready && !schedules.length" class="muted-copy"
        >暂无关联日程</text
      >
      <view v-for="item in schedules" :key="item.id" class="schedule">
        <view class="item-head">
          <DoneToggle
            :title="item.title"
            :checked="Boolean(item.done)"
            :disabled="!canEdit"
            @change="toggleSchedule(item)"
          />
          <text class="item-title" :class="{ done: item.done }">{{
            item.title
          }}</text>
        </view>
        <text class="duration">{{
          timeRange(item.start_at, item.end_at)
        }}</text>
      </view>
    </view>
    <ConfirmDialog
      :visible="!!deleting"
      title="删除步骤"
      :message="
        '删除「' + (deleting?.title ?? '') + '」？已经确认的日程会保留。'
      "
      confirm-text="删除"
      destructive
      @cancel="deleting = null"
      @confirm="confirmRemove"
    />
  </view>
</template>

<style scoped>
.card {
  padding: var(--space-4);
  margin-top: var(--space-3);
}
.header,
.item-head,
.row-tools,
.toolbar {
  display: flex;
  align-items: center;
}
.header {
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.add-step,
.plan-action {
  flex-shrink: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.step,
.schedule {
  margin-top: var(--space-2);
  padding: 0 var(--space-2) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.item-head {
  margin-left: -4px;
}
.item-title {
  min-width: 0;
  flex: 1;
  color: var(--text);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.done {
  color: var(--text-muted);
  text-decoration: line-through;
}
.duration {
  display: block;
  margin-left: 40px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-muted);
}
.detail {
  display: block;
  margin: var(--space-2) 0 0 40px;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.row-tools {
  justify-content: flex-end;
}
.remove {
  color: var(--danger);
}
.toolbar {
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}
.plan-action {
  background: var(--primary-soft);
}
.add-step[disabled],
.plan-action[disabled] {
  opacity: 0.55;
}
.muted-copy {
  margin-bottom: var(--space-2);
}
@media (min-width: 400px) {
  .card {
    padding-right: var(--space-5);
    padding-left: var(--space-5);
  }
}
</style>
