<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { onHide, onLoad, onShow } from '@dcloudio/uni-app'
import AppNavBar from '@/components/AppNavBar.vue'
import EmptyState from '@/components/EmptyState.vue'
import ExpansionCard from '@/components/ExpansionCard.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import MaterialCard from '@/components/MaterialCard.vue'
import WorkflowCard from '@/components/WorkflowCard.vue'
import {
  advanceIdeaStatus,
  ideaStatusLabels,
  loadIdea,
  saveIdeaEdits,
  type Idea,
} from '@/services/library'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'
import { useDraftStore } from '@/store/draft'
import { characterCount, maxIdeaLength } from '@/utils/ideaText'
import { syncedDataRevision } from '@/services/sync'

defineOptions({ name: 'IdeaDetailPage' })

const appearance = useAppearanceStore()
const auth = useAuthStore()
const draft = useDraftStore()
const mode = ref<'draft' | 'saved' | null>(null)
const id = ref('')
const idea = shallowRef<Idea | null>(null)
const loading = ref(false)
const error = ref('')
const editing = ref(false)
const content = ref('')
const tagInputs = ref<{ key: number; value: string }[]>([])
const pending = ref<'save' | 'advance' | null>(null)
const editError = ref('')
let tagKey = 0
const visible = ref(false)
let revision = 0
const isDraft = computed(() => mode.value === 'draft')
const destination = computed(() =>
  isDraft.value ? '/pages/record/index' : '/pages/ideas/index',
)
const date = computed(() => {
  if (!idea.value) return ''
  const local = new Date(idea.value.created_at)
  const hours = String(local.getHours()).padStart(2, '0')
  const minutes = String(local.getMinutes()).padStart(2, '0')
  return `${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日 ${hours}:${minutes}`
})
const validId = computed(() =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id.value),
)
const count = computed(() => characterCount(content.value))
const inputError = computed(() => {
  if (!content.value.trim()) return '原文不能为空。'
  return count.value > maxIdeaLength ? '单条想法最多 2000 字。' : ''
})

function stopEditing() {
  editing.value = false
  content.value = ''
  tagInputs.value = []
  editError.value = ''
}

function startEditing() {
  if (!idea.value || pending.value) return
  content.value = idea.value.content
  tagInputs.value = idea.value.tags.map((value) => ({ key: ++tagKey, value }))
  editError.value = ''
  editing.value = true
}

function addTag() {
  tagInputs.value.push({ key: ++tagKey, value: '' })
}

async function refresh() {
  if (editing.value || pending.value) return
  const current = ++revision
  // 刷新同一条想法时保留详情卡片，以免同步打断生成或模板选择。
  if (idea.value?.id !== id.value || idea.value?.user_id !== auth.user?.id)
    idea.value = null
  error.value = ''
  loading.value = false
  if (!visible.value || mode.value !== 'saved' || !auth.user || !validId.value)
    return
  loading.value = !idea.value
  try {
    const saved = await loadIdea(auth.user.id, id.value)
    if (revision === current) idea.value = saved
  } catch (cause) {
    if (revision === current)
      error.value =
        cause instanceof Error ? cause.message : '读取想法失败，请重试。'
  } finally {
    if (revision === current) loading.value = false
  }
}

async function submit(action: 'save' | 'advance') {
  const owner = auth.user?.id
  const saved = idea.value
  if (
    !owner ||
    !saved ||
    pending.value ||
    (action === 'save' && inputError.value)
  )
    return
  const current = revision
  pending.value = action
  editError.value = ''
  try {
    const result =
      action === 'save'
        ? await saveIdeaEdits(
            owner,
            saved.id,
            content.value,
            tagInputs.value.map((tag) => tag.value),
          )
        : await advanceIdeaStatus(owner, saved.id, saved.status)
    if (revision !== current) return
    idea.value = result
    stopEditing()
    if (visible.value)
      uni.showToast({
        title: action === 'save' ? '已保存' : ideaStatusLabels[result.status],
        icon: 'none',
      })
  } catch (cause) {
    if (revision === current)
      editError.value =
        cause instanceof Error ? cause.message : '修改失败，请重试。'
  } finally {
    if (revision === current) pending.value = null
  }
}

onLoad((query) => {
  id.value = typeof query?.id === 'string' ? query.id : ''
  mode.value = query?.draft === '1' ? 'draft' : 'saved'
  if (visible.value) void refresh()
})
onShow(() => {
  visible.value = true
  void refresh()
})
onHide(() => {
  visible.value = false
})
watch(syncedDataRevision, () => {
  if (visible.value) void refresh()
})
onBeforeUnmount(() => {
  visible.value = false
  revision++
})
watch(
  () => auth.user?.id,
  () => {
    stopEditing()
    pending.value = null
    void refresh()
  },
  { flush: 'sync' },
)

async function leave(login = false) {
  try {
    if (login) await uni.navigateTo({ url: '/pages/auth/login' })
    else await uni.switchTab({ url: destination.value })
  } catch {
    uni.showToast({ title: '页面打开失败，请重试', icon: 'none' })
  }
}
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar
      :title="isDraft ? '草稿预览' : '想法详情'"
      back
      :fallback-tab="destination"
    />
    <view class="page-body">
      <view
        v-if="!mode || loading"
        class="surface detail-card"
        aria-live="polite"
      >
        <LoadingButton
          label="读取想法"
          loading
          loading-text="正在读取想法…"
          variant="secondary"
        />
      </view>
      <view v-else-if="isDraft" class="surface">
        <view v-if="draft.text.trim()" class="detail-card">
          <text class="eyebrow">未保存的草稿</text>
          <text class="detail-content" selectable>{{ draft.text }}</text>
          <button class="quiet-button" @click="leave()">返回编辑</button>
        </view>
        <EmptyState
          v-else
          title="草稿还是空的"
          action-text="去记录"
          @action="leave()"
        />
      </view>
      <view v-else-if="!validId" class="surface">
        <EmptyState
          title="想法链接无效"
          action-text="返回想法库"
          @action="leave()"
        />
      </view>
      <view v-else-if="!auth.user" class="surface">
        <EmptyState
          title="登录后查看想法"
          action-text="去登录"
          @action="leave(true)"
        />
      </view>
      <view v-else-if="error && !idea" class="surface detail-card">
        <text class="error-text" role="alert">{{ error }}</text>
        <LoadingButton label="重新读取" variant="secondary" @click="refresh" />
      </view>
      <view v-else-if="!idea" class="surface">
        <EmptyState
          title="未找到这条想法"
          action-text="返回想法库"
          @action="leave()"
        />
      </view>
      <template v-else>
        <view v-if="error" class="error-text" role="alert">
          <text>{{ error }}</text>
          <button class="quiet-button" @click="refresh">重新读取</button>
        </view>
        <view class="surface detail-card original-card">
          <view class="heading-row">
            <view class="original-heading">
              <text class="section-title">原文</text>
              <text class="detail-date">{{ date }}</text>
            </view>
            <button
              v-if="!editing"
              class="quiet-button edit-button"
              :disabled="!!pending"
              @click="startEditing"
            >
              编辑
            </button>
            <button
              v-else
              class="quiet-button edit-button"
              :disabled="!!pending"
              @click="stopEditing"
            >
              取消
            </button>
          </view>
          <template v-if="editing">
            <textarea
              v-model="content"
              class="detail-input"
              aria-label="编辑原文"
              :maxlength="-1"
              :cursor-spacing="16"
              :disabled="!!pending"
            />
            <text class="detail-count">{{ count }} / {{ maxIdeaLength }}</text>
            <view class="heading-row tags-header">
              <text class="field-label">标签</text>
              <button
                class="quiet-button"
                :disabled="!!pending"
                @click="addTag"
              >
                添加标签
              </button>
            </view>
            <view
              v-for="(tag, index) in tagInputs"
              :key="tag.key"
              class="tag-field"
            >
              <input
                v-model="tag.value"
                class="tag-input"
                :aria-label="'标签 ' + (index + 1)"
                placeholder="标签名称"
                :maxlength="-1"
                :disabled="!!pending"
              />
              <button
                class="quiet-button remove"
                :aria-label="'移除标签 ' + (index + 1)"
                :disabled="!!pending"
                @click="tagInputs.splice(index, 1)"
              >
                移除
              </button>
            </view>
            <text
              v-if="inputError || editError"
              class="error-text"
              role="alert"
              >{{ inputError || editError }}</text
            >
            <LoadingButton
              label="保存修改"
              :loading="pending === 'save'"
              loading-text="正在保存…"
              :disabled="!!inputError"
              @click="submit('save')"
            />
          </template>
          <template v-else>
            <text class="detail-content" selectable>{{ idea.content }}</text>
            <view v-if="idea.tags.length" class="detail-tags">
              <text
                v-for="(tag, index) in idea.tags"
                :key="index"
                class="detail-tag"
                ># {{ tag }}</text
              >
            </view>
            <view class="status-row">
              <text class="detail-status">{{
                ideaStatusLabels[idea.status]
              }}</text>
              <button
                v-if="idea.status !== 'archived'"
                class="quiet-button"
                :disabled="!!pending"
                @click="submit('advance')"
              >
                {{
                  pending
                    ? '正在更新…'
                    : idea.status === 'inbox'
                      ? '标为已处理'
                      : '归档'
                }}
              </button>
            </view>
            <text v-if="editError" class="error-text" role="alert">{{
              editError
            }}</text>
          </template>
        </view>
        <ExpansionCard
          :key="idea.id + ':' + auth.revision"
          :idea-id="idea.id"
          :original="idea.content"
          :owner="idea.user_id"
          :editing="editing"
        />
        <MaterialCard
          :key="'materials-' + idea.id + ':' + auth.revision"
          :idea-id="idea.id"
          :owner="idea.user_id"
          :editing="editing"
          :visible="visible"
        />
        <WorkflowCard
          :key="'flow-' + idea.id + ':' + auth.revision"
          :idea-id="idea.id"
          :owner="idea.user_id"
          :editing-original="editing"
          :visible="visible"
        />
      </template>
    </view>
  </view>
</template>

<style scoped>
.detail-card {
  display: flex;
  flex-direction: column;
  padding: var(--space-4);
}
.heading-row,
.status-row,
.tag-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.original-heading {
  min-width: 0;
}
.edit-button {
  flex-shrink: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.detail-date,
.detail-count {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.detail-date {
  margin-top: var(--space-1);
}
.detail-count {
  align-self: flex-end;
  margin-top: var(--space-1);
}
.detail-content {
  margin: var(--space-4) 0;
  color: var(--text);
  font-size: 17px;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.detail-input,
.tag-input {
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text);
  padding: var(--space-3);
}
.detail-input:focus-within,
.tag-input:focus-within {
  border-color: var(--primary);
}
.detail-input {
  width: 100%;
  height: 154px;
  margin-top: var(--space-3);
  font-size: 17px;
  line-height: 1.65;
}
.tags-header {
  margin: var(--space-1) 0 var(--space-2);
}
.field-label {
  font-size: 15px;
  font-weight: 600;
}
.tag-field {
  margin-bottom: var(--space-2);
}
.tag-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  font-size: 15px;
}
.remove {
  color: var(--danger);
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}
.detail-tag,
.detail-status {
  max-width: 100%;
  padding: var(--space-1) var(--space-2);
  border-radius: 999px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.detail-tag {
  background: var(--bg);
  color: var(--text-secondary);
}
.status-row {
  min-height: 44px;
  border-top: 1px solid var(--border);
  padding-top: var(--space-2);
}
.detail-status {
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}
@media (min-width: 400px) {
  .original-card {
    padding-right: var(--space-5);
    padding-left: var(--space-5);
  }
}
</style>
