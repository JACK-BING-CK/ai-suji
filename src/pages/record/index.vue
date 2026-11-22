<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import AppNavBar from '@/components/AppNavBar.vue'
import EmptyState from '@/components/EmptyState.vue'
import InboxRow from '@/components/InboxRow.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import { useInboxList } from '@/services/library'
import { deleteIdea, saveDraft, type DraftSource } from '@/services/record'
import { useVoiceRecorder } from '@/services/voiceRecorder'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'
import { useDraftStore } from '@/store/draft'
import { characterCount, maxIdeaLength } from '@/utils/ideaText'

const appearance = useAppearanceStore()
const auth = useAuthStore()
const draft = useDraftStore()
const { rows, loading, error: listError, refresh } = useInboxList()
const today = ref(new Date())
const saving = ref(false)
const editorRevision = ref(0)
const deleting = ref('')
const openRow = ref('')
const error = ref('')
const count = computed(() => characterCount(draft.text))
const tooLong = computed(() => count.value > maxIdeaLength)
const text = computed({
  get: () => draft.text,
  set: (value: string) => {
    error.value = ''
    draft.edit(value)
  },
})
const {
  phase,
  pending: pendingVoice,
  start,
  retry,
  discard,
  release,
  interruptTouch,
  hide,
  show,
} = useVoiceRecorder({
  owner: () => auth.user?.id,
  onTranscript: (value) => {
    draft.appendTranscript(value)
    error.value = ''
  },
  onError: (message) => {
    error.value = message
  },
})
const voiceLabels = {
  idle: '按住说话',
  authorizing: '等待麦克风授权…',
  recording: '松开转写',
  transcribing: '正在转写…',
}
let saveAfterLogin: { text: string; source: DraftSource } | undefined
let appInBackground = false
let pageVisible = false
// #ifdef APP-PLUS
// 原生权限页先触发应用隐藏，再触发页面隐藏；普通页面跳转只触发后者。
const appHidden = () => {
  appInBackground = true
}
const appShown = () => {
  appInBackground = false
}
uni.onAppHide(appHidden)
uni.onAppShow(appShown)
onBeforeUnmount(() => {
  uni.offAppHide(appHidden)
  uni.offAppShow(appShown)
})
// #endif

onShow(() => {
  pageVisible = true
  show()
  today.value = new Date()
  const pending = saveAfterLogin
  saveAfterLogin = undefined
  if (
    auth.user &&
    pending &&
    pending.text === draft.text &&
    pending.source === draft.source
  )
    void save()
})
onHide(() => {
  pageVisible = false
  hide(appInBackground)
  openRow.value = ''
})
onBeforeUnmount(() => hide(false))
watch(
  () => auth.user?.id,
  () => {
    hide(false)
    if (pageVisible) show()
    openRow.value = ''
    error.value = ''
  },
  { flush: 'sync' },
)

async function startVoice() {
  if (saving.value || phase.value !== 'idle') return
  error.value = ''
  try {
    if (!auth.token) {
      await uni.navigateTo({ url: '/pages/auth/login' })
      return
    }
    await start()
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '暂时无法录音，请重试。'
  }
}

async function save() {
  if (
    saving.value ||
    phase.value !== 'idle' ||
    !draft.text.trim() ||
    tooLong.value
  )
    return
  error.value = ''
  saving.value = true
  const owner = auth.user?.id
  const { text: original, source } = draft
  try {
    if (!owner) {
      saveAfterLogin = { text: original, source }
      await uni.navigateTo({ url: '/pages/auth/login' })
      return
    }
    await saveDraft(owner, original, source)
    if (auth.user?.id !== owner) return
    if (draft.text === original && draft.source === source) {
      draft.$reset()
      // 销毁旧输入框，避免失焦后迟到的 input 事件回填刚保存的文字。
      editorRevision.value++
    }
    uni.showToast({ title: '已保存', icon: 'none' })
    await refresh()
  } catch (cause) {
    saveAfterLogin = undefined
    if (auth.user?.id === owner)
      error.value =
        cause instanceof Error ? cause.message : '保存失败，请重试。'
  } finally {
    saving.value = false
  }
}

async function remove(id: string) {
  const owner = auth.user?.id
  if (!owner || deleting.value) return
  deleting.value = id
  error.value = ''
  try {
    await deleteIdea(owner, id)
    if (auth.user?.id !== owner) return
    rows.value = rows.value.filter((item) => item.id !== id)
    openRow.value = ''
    await refresh()
  } catch (cause) {
    if (auth.user?.id === owner)
      error.value =
        cause instanceof Error ? cause.message : '删除失败，请重试。'
  } finally {
    deleting.value = ''
  }
}

async function openDetail(id: string) {
  try {
    openRow.value = ''
    await uni.navigateTo({
      url: '/pages/ideas/detail?id=' + encodeURIComponent(id),
    })
  } catch {
    error.value = '详情页打开失败，请重试。'
  }
}
</script>

<template>
  <view class="app-page record-page" :class="appearance.pageClass">
    <AppNavBar title="记录">
      <template #right>
        <navigator
          class="quiet-button library-link"
          open-type="switchTab"
          url="/pages/ideas/index"
          >想法库 ›</navigator
        >
      </template>
    </AppNavBar>
    <view class="page-body composer">
      <view class="surface note-sheet">
        <view class="note-heading">
          <text class="note-title">速记草稿</text>
          <text class="note-date"
            >{{ today.getMonth() + 1 }}月{{ today.getDate() }}日 · 星期{{
              '日一二三四五六'[today.getDay()]
            }}</text
          >
        </view>
        <textarea
          :key="editorRevision"
          v-model="text"
          class="note-input"
          placeholder-class="note-placeholder"
          placeholder="此刻有什么想法？"
          aria-label="速记草稿"
          :maxlength="-1"
          :cursor-spacing="16"
        />
        <view class="note-footer">
          <navigator
            v-if="draft.text.trim()"
            class="quiet-button preview"
            url="/pages/ideas/detail?draft=1"
            >预览草稿 ›</navigator
          >
          <text class="note-count" :class="{ 'note-count--over': tooLong }"
            >{{ count }} / {{ maxIdeaLength }}</text
          >
        </view>
        <view class="note-actions">
          <button
            v-if="!pendingVoice"
            class="voice-button"
            :class="{ 'voice-button--active': phase === 'recording' }"
            :disabled="saving || phase === 'transcribing'"
            @touchstart.stop.prevent="startVoice"
            @touchend.stop.prevent="release"
            @touchcancel="interruptTouch"
          >
            <view v-if="phase === 'idle'" class="mic-mark" aria-hidden="true" />
            <text>{{ voiceLabels[phase] }}</text>
          </button>
          <button
            v-else
            class="voice-button"
            :disabled="saving || phase !== 'idle'"
            @click="retry"
          >
            {{ phase === 'transcribing' ? '正在转写…' : '重新转写' }}
          </button>
          <view class="save-button">
            <LoadingButton
              label="保存"
              loading-text="正在保存…"
              :loading="saving"
              :disabled="!draft.text.trim() || tooLong || phase !== 'idle'"
              @click="save"
            />
          </view>
        </view>
        <view
          v-if="pendingVoice && phase === 'idle'"
          class="note-footer pending-voice"
        >
          <text>有一段待转写录音</text>
          <button class="quiet-button" @click="discard">丢弃录音</button>
        </view>
      </view>
      <text
        v-if="tooLong || error"
        class="error-text record-error"
        role="alert"
        >{{ tooLong ? '单条想法最多 2000 字，请删减后保存。' : error }}</text
      >
    </view>
    <view class="page-body inbox-heading">
      <view class="inbox-title">
        <text class="section-title">收集箱</text>
        <text v-if="rows.length" class="inbox-count">{{ rows.length }}</text>
      </view>
      <text v-if="rows.length" class="swipe-hint">左滑删除</text>
    </view>
    <scroll-view scroll-y class="inbox-scroll">
      <view class="page-body inbox-body">
        <view v-if="listError" class="surface">
          <EmptyState
            title="收集箱读取失败"
            :description="listError"
            action-text="重新读取"
            @action="refresh"
          />
        </view>
        <view v-else-if="loading && !rows.length" class="surface">
          <LoadingButton
            loading
            label="读取收集箱"
            loading-text="正在读取…"
            variant="secondary"
          />
        </view>
        <view v-else-if="!rows.length" class="surface">
          <EmptyState
            title="收集箱是空的"
            description="保存的速记会出现在这里。"
          />
        </view>
        <view v-else class="inbox-list">
          <InboxRow
            v-for="item in rows"
            :key="item.id"
            :item="item"
            :open="openRow === item.id"
            :deleting="deleting === item.id"
            @reveal="openRow = $event ? item.id : ''"
            @detail="openDetail(item.id)"
            @remove="remove(item.id)"
          />
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<style scoped>
.record-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  overflow: hidden;
}
.composer,
.inbox-heading,
.inbox-body {
  width: 100%;
}
.composer {
  flex: none;
  padding-top: var(--space-2);
  padding-bottom: 0;
}
.note-sheet {
  padding: 16px;
  background: linear-gradient(165deg, var(--primary-soft), var(--surface) 54%);
  box-shadow: var(--shadow-card);
}
.library-link {
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  white-space: nowrap;
}
.note-title {
  color: var(--text);
  font-size: 17px;
  line-height: 1.3;
  font-weight: 700;
}
.note-heading,
.note-footer,
.inbox-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.note-date {
  text-align: right;
}
.note-date,
.note-count,
.swipe-hint {
  color: var(--text-muted);
  font-size: 12px;
}
.note-input {
  box-sizing: border-box;
  width: 100%;
  height: 105px;
  padding: 12px;
  margin-top: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font-size: 17px;
  line-height: 1.5;
}
.note-placeholder {
  color: var(--text-muted);
}
.note-footer {
  min-height: 32px;
  margin-bottom: var(--space-2);
}
.preview {
  min-height: 40px;
  padding: 0;
  font-size: 13px;
}
.note-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.note-count--over {
  color: var(--danger);
}
.pending-voice {
  margin: var(--space-2) 0 0;
  color: var(--text-muted);
  font-size: 13px;
}
.note-actions {
  display: flex;
  align-items: stretch;
}
.voice-button,
.save-button {
  flex: 1;
  min-width: 0;
}
.voice-button {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 var(--space-2) 0 0;
  padding: 6px;
  min-height: 48px;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.voice-button::after {
  border: 0;
}
.voice-button--active {
  border-color: var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
}
.mic-mark {
  position: relative;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  align-self: center;
  border: 1.5px solid currentColor;
  border-top: 0;
  border-radius: 0 0 8px 8px;
}
.mic-mark::before {
  position: absolute;
  top: -4px;
  left: 3px;
  width: 5px;
  height: 11px;
  border-radius: 5px;
  background: currentColor;
  content: '';
}
.mic-mark::after {
  position: absolute;
  left: 5px;
  bottom: -5px;
  width: 1.5px;
  height: 5px;
  background: currentColor;
  content: '';
}
.record-error {
  margin: var(--space-2) 0 0;
}
.inbox-heading {
  flex: none;
  padding-top: var(--space-5);
  padding-bottom: var(--space-3);
}
.inbox-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.inbox-count {
  border-radius: 99px;
  padding: 2px 8px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.inbox-scroll {
  flex: 1;
  min-height: 0;
  height: 0;
}
.inbox-body {
  padding-top: 0;
}
.inbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
@media (max-height: 530px) {
  .note-input {
    height: 62px;
    margin-top: var(--space-1);
  }
  .note-sheet {
    padding: var(--space-3);
  }
  .note-footer {
    margin-bottom: 0;
  }
  .inbox-heading {
    padding-top: var(--space-3);
    padding-bottom: var(--space-2);
  }
}
</style>
