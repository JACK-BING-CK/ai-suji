<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppNavBar from '@/components/AppNavBar.vue'
import EmptyState from '@/components/EmptyState.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import {
  filterIdeas,
  ideaStatusLabels,
  listIdeaTags,
  useIdeaList,
  type IdeaFilterStatus,
} from '@/services/library'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'

const appearance = useAppearanceStore()
const auth = useAuthStore()
const { rows, loading, error, refresh } = useIdeaList()
const statuses: IdeaFilterStatus[] = [
  'active',
  'inbox',
  'processed',
  'archived',
]
const keyword = ref('')
const tag = ref('')
const status = ref<IdeaFilterStatus>('active')
const tags = computed(() => {
  const available = listIdeaTags(rows.value)
  // 标签改名后保留已选条件，用户仍可看到并清除它。
  return tag.value && !available.includes(tag.value)
    ? [tag.value, ...available]
    : available
})
const shown = computed(() =>
  filterIdeas(rows.value, {
    keyword: keyword.value,
    tag: tag.value,
    status: status.value,
  }).map((item) => {
    const content = item.content.trim()
    const lineBreak = content.indexOf('\n')

    return {
      ...item,
      title: lineBreak < 0 ? content : content.slice(0, lineBreak).trim(),
      preview: lineBreak < 0 ? '' : content.slice(lineBreak + 1).trim(),
    }
  }),
)
const filtering = computed(
  () => !!(keyword.value.trim() || tag.value || status.value !== 'active'),
)

function clearFilters() {
  keyword.value = ''
  tag.value = ''
  status.value = 'active'
}

watch(() => auth.user?.id, clearFilters, { flush: 'sync' })

function dateLabel(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function navigationFailed() {
  uni.showToast({ title: '页面打开失败，请重试', icon: 'none' })
}

async function openEmptyAction() {
  try {
    if (!auth.user) await uni.navigateTo({ url: '/pages/auth/login' })
    else if (filtering.value) clearFilters()
    else await uni.switchTab({ url: '/pages/record/index' })
  } catch {
    navigationFailed()
  }
}
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="想法库">
      <template #right>
        <navigator
          class="quiet-button record-link"
          url="/pages/record/index"
          open-type="switchTab"
          @fail="navigationFailed"
          ><text aria-hidden="true">＋</text><text>去记录</text></navigator
        >
      </template>
    </AppNavBar>
    <view class="page-body">
      <view v-if="auth.user" class="library-filters">
        <view class="search-box">
          <view class="search-icon" aria-hidden="true" />
          <input
            v-model="keyword"
            class="search-input"
            type="text"
            confirm-type="search"
            :maxlength="-1"
            placeholder="搜索原文或标签"
            placeholder-class="search-placeholder"
            aria-label="搜索原文或标签"
          />
          <button
            v-if="keyword"
            class="quiet-button clear-search"
            aria-label="清空搜索"
            @click="keyword = ''"
          >
            清空
          </button>
        </view>
        <view class="status-filters" aria-label="按状态筛选">
          <button
            v-for="option in statuses"
            :key="option"
            class="status-filter"
            :class="{ 'status-filter--selected': status === option }"
            :aria-pressed="status === option"
            @click="status = option"
          >
            {{ option === 'active' ? '未归档' : ideaStatusLabels[option] }}
          </button>
        </view>
        <scroll-view
          v-if="tags.length"
          scroll-x
          class="tag-scroll"
          aria-label="按标签筛选"
        >
          <view class="tag-filters">
            <button
              class="tag-filter"
              :class="{ 'tag-filter--selected': !tag }"
              :aria-pressed="!tag"
              @click="tag = ''"
            >
              全部标签
            </button>
            <button
              v-for="option in tags"
              :key="option"
              class="tag-filter"
              :class="{ 'tag-filter--selected': option === tag }"
              :aria-pressed="option === tag"
              @click="tag = option"
            >
              # {{ option }}
            </button>
          </view>
        </scroll-view>
      </view>

      <view v-if="!auth.user" class="surface">
        <EmptyState
          title="还没有登录"
          description="登录后，可以查看保存在这台设备上的想法。"
          action-text="去登录"
          @action="openEmptyAction"
        />
      </view>
      <view v-else-if="error" class="surface">
        <EmptyState
          title="想法库暂时无法读取"
          :description="error"
          action-text="重新读取"
          @action="refresh"
        />
      </view>
      <view
        v-else-if="loading"
        class="surface ideas-loading"
        aria-live="polite"
      >
        <LoadingButton
          loading
          label="读取想法"
          loading-text="正在读取想法…"
          variant="secondary"
        />
      </view>
      <view v-else-if="!shown.length" class="surface">
        <EmptyState
          :title="filtering ? '没有符合条件的想法' : '还没有未归档的想法'"
          :description="
            filtering ? undefined : '记下一条想法，就能在这里找到。'
          "
          :action-text="filtering ? '清除筛选' : '去记录'"
          @action="openEmptyAction"
        />
      </view>
      <view v-else class="ideas-list">
        <view class="results-bar">
          <text class="result-count" aria-live="polite"
            >{{ shown.length }} 条想法</text
          >
          <button v-if="filtering" class="quiet-button" @click="clearFilters">
            清除筛选
          </button>
        </view>
        <navigator
          v-for="item in shown"
          :key="item.id"
          class="surface idea-row"
          :url="'/pages/ideas/detail?id=' + encodeURIComponent(item.id)"
          hover-class="idea-row--pressed"
          @fail="navigationFailed"
        >
          <view class="idea-row__meta">
            <text>{{ dateLabel(item.created_at) }}</text>
            <text class="status-badge" :class="'status-badge--' + item.status">
              {{ ideaStatusLabels[item.status] }}
            </text>
          </view>
          <view class="idea-row__heading">
            <text class="idea-row__title">{{ item.title }}</text>
            <view class="idea-row__chevron" aria-hidden="true" />
          </view>
          <text v-if="item.preview" class="idea-row__preview">{{
            item.preview
          }}</text>
          <view v-if="item.tags.length" class="idea-row__tags">
            <text
              v-for="(label, index) in item.tags"
              :key="index"
              class="idea-tag"
              ># {{ label }}</text
            >
          </view>
        </navigator>
      </view>
    </view>
  </view>
</template>

<style scoped>
.record-link {
  gap: 4px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--primary-soft);
}
.library-filters {
  margin-bottom: var(--space-3);
}
.search-box {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 52px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.search-box:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.search-icon {
  position: relative;
  flex: none;
  box-sizing: border-box;
  width: 15px;
  height: 15px;
  margin: -2px var(--space-3) 0 0;
  border: 1.5px solid var(--text-muted);
  border-radius: 50%;
}
.search-icon::after {
  position: absolute;
  right: -5px;
  bottom: -2px;
  width: 7px;
  height: 1.5px;
  background: var(--text-muted);
  content: '';
  transform: rotate(45deg);
}
.search-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  color: var(--text);
  font-size: 16px;
}
.search-placeholder {
  color: var(--text-muted);
}
.clear-search {
  margin-right: -4px;
}
.status-filters {
  display: flex;
  margin-top: var(--space-3);
  padding: 4px;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.status-filter,
.tag-filter {
  margin: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.45;
}
.status-filter::after,
.tag-filter::after {
  border: 0;
}
.status-filter {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: var(--space-2) 0;
  border-radius: 10px;
}
.status-filter--selected {
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 700;
}
.tag-scroll {
  margin-top: var(--space-3);
  white-space: nowrap;
}
.tag-filters {
  display: inline-flex;
  align-items: center;
}
.tag-filter {
  flex: none;
  max-width: 70vw;
  min-height: 44px;
  margin-right: var(--space-2);
  padding: var(--space-2) var(--space-3);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 999px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-filter--selected {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}
.ideas-loading {
  padding: var(--space-5);
}
.ideas-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.results-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
}
.result-count {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.idea-row {
  display: block;
  padding: var(--space-4);
}
.idea-row--pressed {
  background: var(--primary-soft);
}
.idea-row__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.status-badge {
  flex: none;
  padding: var(--space-1) var(--space-2);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.status-badge--inbox {
  color: var(--primary);
}
.status-badge--processed {
  background: var(--primary-soft);
  color: var(--primary);
}
.idea-row__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.idea-row__chevron {
  flex: 0 0 7px;
  box-sizing: border-box;
  height: 7px;
  margin-right: 4px;
  border: solid var(--text-muted);
  border-width: 1.5px 1.5px 0 0;
  transform: rotate(45deg);
}
.idea-row__title,
.idea-row__preview {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
}
.idea-row__title {
  color: var(--text);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.45;
}
.idea-row__preview {
  margin-top: var(--space-1);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.55;
}
.idea-row__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.idea-tag {
  max-width: 100%;
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg);
  overflow-wrap: anywhere;
  word-break: break-word;
  color: var(--primary);
  font-size: 12px;
}
</style>
