<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { onHide, onLoad, onShow } from '@dcloudio/uni-app'
import AppNavBar from '@/components/AppNavBar.vue'
import DoneToggle from '@/components/DoneToggle.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import ReminderEditor from '@/components/ReminderEditor.vue'
import {
  isOccurrenceDone,
  matchesOccurrence,
  repeatLabel,
} from '@/services/calendar'
import {
  loadScheduleReminders,
  reminderRevision,
  saveReminderSettings,
} from '@/services/reminderService'
import { setOccurrenceDone } from '@/services/schedules'
import { syncedDataRevision } from '@/services/sync'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'
import { calendarDate, clockTime } from '@/utils/localDateTime'

defineOptions({ name: 'ScheduleDetailPage' })
const appearance = useAppearanceStore()
const auth = useAuthStore()
type Detail = Awaited<ReturnType<typeof loadScheduleReminders>>
type Input = Parameters<typeof saveReminderSettings>[2]
type Reminder = Detail['reminders'][number]
const id = ref('')
const requestedAt = ref<number>()
const data = shallowRef<Detail>()
const editing = shallowRef<Input>()
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const writeError = ref('')
let ios = false
// #ifdef APP-PLUS
// iOS 使用有声音时长上限的本地通知。
ios = uni.getSystemInfoSync().platform === 'ios'
// #endif
const at = computed(() => {
  const schedule = data.value?.schedule
  if (!schedule) return 0
  return requestedAt.value !== undefined &&
    matchesOccurrence(schedule, requestedAt.value)
    ? requestedAt.value
    : schedule.start_at
})
const done = computed(() =>
  data.value ? isOccurrenceDone(data.value.schedule, at.value) : false,
)
const dateLabel = (value: number) =>
  calendarDate(value) + ' ' + clockTime(value)
const range = computed(() => {
  if (!data.value) return ''
  const { start_at, end_at } = data.value.schedule
  const end = at.value + end_at - start_at
  return (
    dateLabel(at.value) +
    ' – ' +
    (calendarDate(end) === calendarDate(at.value)
      ? clockTime(end)
      : dateLabel(end))
  )
})
let visible = false
let readRevision = 0
async function refresh() {
  const request = ++readRevision
  const owner = auth.user?.id
  if (!visible || !owner) return
  error.value = ''
  if (!id.value) {
    error.value = '缺少日程编号，请从日程列表重新打开。'
    return
  }
  loading.value = !data.value
  try {
    const result = await loadScheduleReminders(owner, id.value)
    if (request === readRevision) data.value = result
  } catch (cause) {
    if (request === readRevision) {
      data.value = undefined
      error.value =
        cause instanceof Error ? cause.message : '读取日程失败，请重试。'
    }
  } finally {
    if (request === readRevision) loading.value = false
  }
}
onLoad((query) => {
  id.value = String(query?.id ?? '')
  const start = query?.at === undefined ? undefined : Number(query.at)
  if (Number.isSafeInteger(start)) requestedAt.value = start
})
onShow(() => {
  visible = true
  void refresh()
})
onHide(() => {
  visible = false
  readRevision++
})
watch(
  () => auth.revision,
  () => {
    data.value = undefined
    editing.value = undefined
    writeError.value = ''
    busy.value = false
    void refresh()
  },
  { flush: 'sync' },
)
watch([syncedDataRevision, reminderRevision], () => {
  if (!busy.value) void refresh()
})

function draft(row?: Reminder): Input {
  return {
    id: row?.id,
    enabled: row?.enabled ?? 0,
    level: row?.level ?? 0,
    remind_at:
      row?.remind_at ??
      Math.max(
        at.value - 600_000,
        Math.ceil((Date.now() + 60_000) / 60_000) * 60_000,
      ),
    snooze_min: row?.snooze_min ?? 10,
  }
}
function edit(row?: Reminder) {
  writeError.value = ''
  editing.value = draft(row)
}
function reminderStatus(row: Reminder) {
  if (!row.enabled) return '已关闭'
  if (data.value?.schedule.done) return '已暂停'
  if (row.remind_at <= Date.now()) return '已到提醒时间'
  return row.native_id ? '已开启' : '待系统登记'
}
function cancelEdit() {
  editing.value = undefined
  writeError.value = ''
}
async function write(job: (owner: string) => Promise<void>, message: string) {
  const owner = auth.user?.id
  if (!owner || busy.value) return
  const revision = auth.revision
  const ids = new Set(data.value?.reminders.map((row) => row.id))
  busy.value = true
  writeError.value = ''
  try {
    await job(owner)
    if (revision !== auth.revision) return
    editing.value = undefined
    await refresh()
    if (visible) uni.showToast({ title: message, icon: 'none' })
  } catch (cause) {
    if (revision !== auth.revision) return
    writeError.value =
      cause instanceof Error ? cause.message : '更新失败，请重试。'
    // 提醒可能已写入 SQLite，但系统注册失败。重新读取已保存的行，避免重试时新建两条。
    await refresh()
    if (
      editing.value &&
      !editing.value.id &&
      data.value?.reminders.some((row) => !ids.has(row.id))
    )
      editing.value = undefined
  } finally {
    if (revision === auth.revision) busy.value = false
  }
}
function save(input: Input) {
  void write(
    (owner) => saveReminderSettings(owner, id.value, input),
    input.enabled ? '提醒已保存' : '提醒已关闭',
  )
}
function toggleDone() {
  const schedule = data.value?.schedule
  if (schedule)
    void write(
      (owner) => setOccurrenceDone(owner, schedule, at.value, !done.value),
      done.value ? '已恢复待办' : '已完成',
    )
}
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="日程详情" back fallback-tab="/pages/schedule/index" />
    <view class="page-body">
      <view v-if="!auth.user" class="surface"
        ><EmptyState title="请登录日程所属账号" />
        <navigator class="quiet-button login" url="/pages/auth/login"
          >去登录 ›</navigator
        ></view
      >
      <view v-else-if="error" class="error-text" role="alert">
        <text>{{ error }}</text>
        <button class="quiet-button" @click="refresh">重新读取</button>
      </view>
      <LoadingButton
        v-else-if="loading"
        loading
        label="读取日程"
        loading-text="正在读取日程…"
        variant="secondary"
      />
      <template v-else-if="data">
        <view class="surface summary">
          <view class="title-line">
            <DoneToggle
              :title="data.schedule.title"
              :checked="done"
              :disabled="busy"
              @change="toggleDone"
            />
            <text class="section-title">{{ data.schedule.title }}</text>
          </view>
          <text class="range">{{ range }}</text>
          <view class="summary-status">
            <text class="status-label">{{ done ? '已完成' : '待办' }}</text>
            <text v-if="data.schedule.priority" class="status-label">重要</text>
            <text class="status-label">{{
              repeatLabel(data.schedule.repeat_rule)
            }}</text>
          </view>
        </view>
        <text v-if="writeError" class="error-text" role="alert">{{
          writeError
        }}</text>
        <view class="surface reminders">
          <view class="heading"
            ><text class="section-title">本地提醒</text
            ><button
              class="quiet-button"
              v-if="!editing && !data.schedule.done"
              :disabled="busy"
              @click="edit()"
            >
              添加提醒
            </button></view
          >
          <text v-if="data.schedule.repeat_rule" class="scope muted-copy"
            >提醒按下方设置的具体日期触发，每条提醒可单独开关。</text
          >
          <text v-if="data.schedule.done" class="scope muted-copy"
            >关联日程已完成，提醒已暂停。</text
          >
          <text
            v-if="!data.reminders.length && !editing"
            class="scope muted-copy"
            >这项日程还没有提醒。</text
          >
          <view v-for="row in data.reminders" :key="row.id" class="reminder">
            <view class="reminder-info"
              ><text class="label">{{
                row.level === 1 ? '闹钟' : '通知'
              }}</text>
              <text class="metadata">{{ reminderStatus(row) }}</text></view
            >
            <text class="range">{{ dateLabel(row.remind_at) }}</text>
            <text v-if="row.level === 1" class="muted-copy"
              >稍后提醒 {{ row.snooze_min }} 分钟</text
            >
            <view v-if="!editing" class="controls"
              ><button
                v-if="!data.schedule.done"
                class="quiet-button"
                :disabled="busy"
                @click="edit(row)"
              >
                {{ row.enabled ? '编辑' : '编辑并开启' }}
              </button>
              <button
                v-if="row.enabled"
                class="quiet-button"
                :disabled="busy"
                @click="save({ ...draft(row), enabled: 0 })"
              >
                关闭提醒
              </button></view
            >
          </view>
          <ReminderEditor
            v-if="editing"
            :key="editing.id || 'new'"
            :initial="editing"
            :busy="busy"
            :ios="ios"
            @save="save"
            @cancel="cancelEdit"
          />
        </view>
        <text v-if="ios" class="muted-copy ios-note"
          >iOS 通过本地通知提醒。系统限制单次自定义铃声短于 30 秒。</text
        >
        <navigator
          class="quiet-button permission-link"
          url="/pages/reminders/permissions"
          >检查本机提醒权限 ›</navigator
        >
      </template>
    </view>
  </view>
</template>
<style scoped>
.summary,
.reminder {
  padding: var(--space-4);
}
.summary {
  margin-bottom: var(--space-4);
  border-color: var(--border);
  background: var(--primary-soft);
}
.title-line,
.heading,
.reminder-info,
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.title-line {
  margin-left: -10px;
}
.title-line .section-title {
  font-size: 21px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.range {
  display: block;
  margin: var(--space-1) 0;
  font-size: 15px;
  line-height: 1.55;
}
.metadata {
  font-size: 13px;
  color: var(--text-secondary);
}
.summary-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-3);
}
.status-label {
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
}
.heading {
  justify-content: space-between;
  padding: var(--space-1) var(--space-4);
  min-height: 52px;
}
.scope {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
}
.reminder {
  border-top: 1px solid var(--border);
}
.reminder-info {
  justify-content: space-between;
  flex-wrap: wrap;
}
.label {
  font-size: 16px;
  font-weight: 600;
}
.controls {
  margin-bottom: calc(-1 * var(--space-2));
}
.controls .quiet-button {
  padding-left: 0;
}
.ios-note,
.permission-link {
  margin-top: var(--space-3);
}
.login {
  margin: 0 var(--space-4) var(--space-3);
}
</style>
