<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { onBackPress, onHide, onShow } from '@dcloudio/uni-app'
import AppNavBar from '@/components/AppNavBar.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import ScheduleCalendar from '@/components/ScheduleCalendar.vue'
import ScheduleEntry from '@/components/ScheduleEntry.vue'
import ScheduleEditor from '@/components/ScheduleEditor.vue'
import {
  buildCalendar,
  moveCalendar,
  type CalendarMode,
  type ScheduleOccurrence,
  type ScheduleRow,
} from '@/services/calendar'
import { useIdeaList, useScheduleList } from '@/services/library'
import {
  saveSchedule,
  deleteSchedule,
  setOccurrenceDone,
  type ScheduleInput,
} from '@/services/schedules'
import { calendarDate, shortDay } from '@/utils/localDateTime'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'

const appearance = useAppearanceStore()
const auth = useAuthStore()
const { rows, loading, error, refresh } = useScheduleList()
const {
  rows: ideas,
  loading: ideasLoading,
  error: ideasError,
  refresh: refreshIdeas,
} = useIdeaList()
const now = ref(Date.now())
const selectedAt = ref(now.value)
const mode = ref<CalendarMode>('month')
const todayLimit = ref(3)
const calendar = computed(() =>
  buildCalendar(
    rows.value,
    selectedAt.value,
    mode.value,
    now.value,
    undefined,
    todayLimit.value,
  ),
)
const selectedLabel = computed(() => {
  const day = new Date(selectedAt.value)
  return shortDay(day) + ' 周' + '日一二三四五六'[day.getDay()]
})
const editing = ref(false)
const original = shallowRef<ScheduleRow>()
const busy = ref(false)
const saveError = ref('')
let timer: ReturnType<typeof setInterval> | undefined

function updateClock() {
  const next = Date.now()
  if (
    calendarDate(selectedAt.value) === calendarDate(now.value) &&
    calendarDate(next) !== calendarDate(now.value)
  )
    selectedAt.value = next
  now.value = next
}
function stopClock() {
  clearInterval(timer)
}
onShow(() => {
  stopClock()
  updateClock()
  timer = setInterval(updateClock, 60_000)
})
onHide(stopClock)
onBeforeUnmount(stopClock)

function closeEditor() {
  editing.value = false
  original.value = undefined
  saveError.value = ''
}
watch(
  () => auth.revision,
  () => {
    closeEditor()
    busy.value = false
    selectedAt.value = Date.now()
    todayLimit.value = 3
  },
  { flush: 'sync' },
)
onBackPress(() => {
  if (!editing.value) return false
  if (!busy.value) closeEditor()
  return true
})

async function openEditor(row?: ScheduleRow) {
  if (busy.value || !auth.user) return
  original.value = row
  editing.value = true
  saveError.value = ''
  try {
    await nextTick()
    await uni.pageScrollTo({ scrollTop: 0, duration: 0 })
  } catch {
    uni.showToast({ title: '可向上滑动查看编辑表单', icon: 'none' })
  }
}

async function write(
  action: (owner: string) => Promise<unknown>,
  success?: () => void,
) {
  const owner = auth.user?.id
  const revision = auth.revision
  if (!owner || busy.value) return
  busy.value = true
  saveError.value = ''
  try {
    await action(owner)
    if (revision !== auth.revision) return
    success?.()
    await refresh()
  } catch (cause) {
    if (revision === auth.revision)
      saveError.value =
        cause instanceof Error ? cause.message : '日程更新失败，请重试。'
  } finally {
    if (revision === auth.revision) busy.value = false
  }
}

function save(input: ScheduleInput) {
  const row = original.value
  void write(
    (owner) => saveSchedule(owner, input, row),
    () => {
      if (!row) selectedAt.value = input.start_at
      closeEditor()
      uni.showToast({ title: '日程已保存', icon: 'none' })
    },
  )
}
function remove() {
  const row = original.value
  if (row)
    void write(
      (owner) => deleteSchedule(owner, row),
      () => {
        closeEditor()
        uni.showToast({ title: '日程已删除', icon: 'none' })
      },
    )
}
function toggle(item: ScheduleOccurrence) {
  void write((owner) =>
    setOccurrenceDone(owner, item.schedule, item.start_at, !item.done),
  )
}
async function openLogin() {
  try {
    await uni.navigateTo({ url: '/pages/auth/login' })
  } catch {
    uni.showToast({ title: '登录页打开失败，请重试', icon: 'none' })
  }
}
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar :title="editing ? (original ? '编辑日程' : '新建日程') : '日程'">
      <template v-if="auth.user" #right>
        <button
          v-if="editing"
          class="quiet-button"
          :disabled="busy"
          @click="closeEditor"
        >
          取消
        </button>
        <button
          v-else
          class="quiet-button create"
          :disabled="busy"
          @click="openEditor()"
        >
          <text aria-hidden="true" class="create-mark">+</text>
          <text>新建</text>
        </button>
      </template>
    </AppNavBar>
    <view class="page-body">
      <view v-if="!auth.user" class="surface">
        <EmptyState
          title="还没有登录"
          description="登录后，可以查看和编辑这台设备上的日程。"
          action-text="去登录"
          @action="openLogin"
        />
      </view>
      <ScheduleEditor
        v-else-if="editing"
        :original="original"
        :selected-at="selectedAt"
        :ideas="ideas"
        :ideas-loading="ideasLoading"
        :ideas-error="ideasError"
        :busy="busy"
        :error="saveError"
        @save="save"
        @remove="remove"
        @retry-ideas="refreshIdeas"
      />
      <view v-else-if="error" class="surface">
        <EmptyState
          title="日程暂时无法读取"
          :description="error"
          action-text="重新读取"
          @action="refresh"
        />
      </view>
      <view v-else-if="loading && !rows.length" class="surface loading">
        <LoadingButton
          loading
          label="读取日程"
          loading-text="正在读取日程…"
          variant="secondary"
        />
      </view>
      <template v-else>
        <text v-if="saveError" class="error-text" role="alert">{{
          saveError
        }}</text>
        <view class="surface todo">
          <view class="section-heading">
            <text class="section-title">今日待办</text>
            <text class="section-date">{{ shortDay(new Date(now)) }}</text>
          </view>
          <ScheduleEntry
            v-for="item in calendar.today"
            :key="item.key"
            :item="item"
            :busy="busy"
            highlight-overdue
            @toggle="toggle(item)"
            @edit="openEditor(item.schedule)"
          />
          <view v-if="!calendar.today.length" class="empty-agenda">
            <text class="quiet-copy">今天没有待办</text>
          </view>
          <button
            v-if="calendar.todayHasMore"
            class="quiet-button more"
            @click="todayLimit += 10"
          >
            更多待办
          </button>
        </view>
        <ScheduleCalendar
          :days="calendar.days"
          :mode="mode"
          :heading="calendar.heading"
          :selected-at="selectedAt"
          @select="selectedAt = $event"
          @today="selectedAt = now"
          @mode="mode = $event"
          @move="selectedAt = moveCalendar(selectedAt, mode, $event)"
        />
        <view class="surface agenda">
          <view class="section-heading">
            <text class="section-title">{{ selectedLabel }}</text>
            <text class="section-date">{{ calendar.selected.length }} 项</text>
          </view>
          <ScheduleEntry
            v-for="item in calendar.selected"
            :key="item.key"
            :item="item"
            :busy="busy"
            @toggle="toggle(item)"
            @edit="openEditor(item.schedule)"
          />
          <view v-if="!calendar.selected.length" class="empty-agenda">
            <text class="quiet-copy">当天没有日程</text>
            <button
              class="quiet-button empty-action"
              :disabled="busy"
              @click="openEditor()"
            >
              新建日程
            </button>
          </view>
        </view>
      </template>
    </view>
  </view>
</template>

<style scoped>
.loading {
  padding: var(--space-4);
}
.create {
  gap: 5px;
  min-height: 44px;
  padding: 0 15px;
  color: var(--on-primary);
  background: var(--primary);
  border-radius: var(--radius-md);
}
.create-mark {
  font-size: 21px;
  font-weight: 400;
  line-height: 1;
}
.todo,
.agenda {
  overflow: hidden;
}
.todo {
  margin-bottom: var(--space-4);
}
.agenda {
  margin-top: var(--space-4);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 56px;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.section-date {
  flex: 0 0 auto;
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.empty-agenda {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0 var(--space-2);
  min-height: 63px;
  padding: 2px var(--space-4);
}
.quiet-copy {
  display: block;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.empty-action {
  padding-right: 0;
}
.more {
  width: 100%;
  border-top: 1px solid var(--border);
}
</style>
