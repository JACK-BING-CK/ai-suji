import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import { scheduleRepository } from '@/repositories/schedule'
import { useAuthStore } from '@/store/auth'
import { listInbox } from './record'
import { listIdeas } from './ideas'
import { syncedDataRevision } from './sync'
import { reminderRevision } from './reminderService'

export {
  advanceIdeaStatus,
  filterIdeas,
  ideaStatusLabels,
  listIdeaTags,
  loadIdea,
  saveIdeaEdits,
  type Idea,
  type IdeaFilterStatus,
} from './ideas'

function useOwnedList<T>(list: (userId: string) => Promise<T[]>) {
  const auth = useAuthStore()
  const rows = shallowRef<T[]>([])
  const error = ref('')
  const loading = ref(false)
  let visible = false
  let revision = 0

  async function refresh() {
    const request = ++revision
    const userId = auth.user?.id
    if (!userId || !visible) return
    loading.value = true
    error.value = ''
    try {
      const result = await list(userId)
      if (request === revision) rows.value = result
    } catch (cause) {
      if (request === revision) {
        error.value =
          cause instanceof Error ? cause.message : '读取失败，请稍后重试。'
      }
    } finally {
      if (request === revision) loading.value = false
    }
  }

  function hide() {
    visible = false
    revision++
    loading.value = false
  }
  watch(
    () => auth.user?.id,
    () => {
      // 切换账号后立刻清空旧列表，阻止较慢的旧请求写回。
      rows.value = []
      error.value = ''
      loading.value = false
      void refresh()
    },
    { flush: 'sync' },
  )
  onShow(() => {
    visible = true
    void refresh()
  })
  onHide(hide)
  watch([syncedDataRevision, reminderRevision], () => {
    if (visible) void refresh()
  })
  onBeforeUnmount(hide)
  return { rows, loading, error, refresh }
}

export function useIdeaList() {
  return useOwnedList(listIdeas)
}

export function useInboxList() {
  return useOwnedList(listInbox)
}

export function useScheduleList() {
  return useOwnedList(scheduleRepository.list)
}
