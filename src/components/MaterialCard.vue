<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import LoadingButton from './LoadingButton.vue'
import {
  deleteMaterial,
  findMaterials,
  loadMaterials,
  openMaterialUrl,
  type Material,
} from '@/services/materials'
import { syncedDataRevision } from '@/services/sync'
import { useAuthStore } from '@/store/auth'
import { calendarDate } from '@/utils/localDateTime'

const props = defineProps<{
  /** 已保存的想法编号。 */
  ideaId: string
  /** 想法所属的账号。 */
  owner: string
  /** 正在编辑原文时等待用户保存再搜索。 */
  editing: boolean
  /** 返回详情页时读取最新的本地素材。 */
  visible: boolean
}>()
const auth = useAuthStore()
const revision = auth.revision
const items = shallowRef<Material[]>([])
const searching = ref(false)
const emptySearch = ref(false)
const searchError = ref('')
const listError = ref('')
const removing = ref('')
let readVersion = 0
let active = true

function current() {
  return active && auth.revision === revision && auth.user?.id === props.owner
}

async function readSaved() {
  const version = ++readVersion
  try {
    const saved = await loadMaterials(props.owner, props.ideaId)
    if (current() && version === readVersion) {
      items.value = saved
      listError.value = ''
    }
  } catch (cause) {
    if (current() && version === readVersion)
      listError.value =
        cause instanceof Error ? cause.message : '读取素材失败。'
  }
}

async function research() {
  if (searching.value || props.editing || !auth.token || !current()) return
  searching.value = true
  emptySearch.value = false
  searchError.value = ''
  try {
    const count = await findMaterials(props.owner, props.ideaId)
    if (!current()) return
    emptySearch.value = count === 0
    await readSaved()
  } catch (cause) {
    if (current())
      searchError.value =
        cause instanceof Error ? cause.message : '搜索失败，请重试。'
  } finally {
    if (current()) searching.value = false
  }
}

async function remove(item: Material) {
  if (removing.value || !current()) return
  removing.value = item.id
  try {
    await deleteMaterial(props.owner, item.id)
    if (!current()) return
    await readSaved()
  } catch (cause) {
    if (current())
      uni.showToast({
        title:
          cause instanceof Error ? cause.message : '删除素材失败，请重试。',
        icon: 'none',
      })
  } finally {
    if (current()) removing.value = ''
  }
}

function openSource(item: Material) {
  openMaterialUrl(item.url, (message) => {
    if (current()) uni.showToast({ title: message, icon: 'none' })
  })
}

watch(
  [() => props.visible, syncedDataRevision],
  () => {
    if (props.visible) void readSaved()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  active = false
})
</script>

<template>
  <view class="surface material-card">
    <text class="section-title">素材</text>
    <view v-for="item in items" :key="item.id" class="material-entry">
      <button
        class="source-link"
        :aria-label="'打开原文：' + item.title"
        @click="openSource(item)"
      >
        <view class="source-heading">
          <text class="material-title">{{ item.title }}</text>
          <text class="source-arrow" aria-hidden="true">↗</text>
        </view>
        <text class="material-meta"
          >{{ item.source_name }} ·
          {{
            item.published_at > 0 ? calendarDate(item.published_at) : '日期未知'
          }}</text
        >
        <text class="material-summary">{{ item.summary }}</text>
      </button>
      <button
        class="quiet-button remove-material"
        :aria-label="'删除素材：' + item.title"
        :disabled="!!removing"
        @click="remove(item)"
      >
        {{ removing === item.id ? '正在删除…' : '删除' }}
      </button>
    </view>
    <view v-if="listError" class="error-text" role="alert">
      <text>{{ listError }}</text>
      <button class="quiet-button" @click="readSaved">重新读取</button>
    </view>
    <text v-if="emptySearch" class="muted-copy" role="status"
      >本次搜索没有找到相关素材。</text
    >
    <text v-if="searchError" class="error-text" role="alert">{{
      searchError
    }}</text>
    <text v-if="editing" class="muted-copy">请先保存原文，再找题材。</text>
    <LoadingButton
      v-if="auth.token"
      :label="searchError ? '重试找题材' : '找题材'"
      loading-text="正在搜索素材…"
      :loading="searching"
      :disabled="editing"
      variant="secondary"
      @click="research"
    />
    <navigator v-else class="quiet-button" url="/pages/auth/login"
      >登录后找题材</navigator
    >
  </view>
</template>

<style scoped>
.material-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-4);
}
.material-entry {
  display: flex;
  flex-direction: column;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
}
.source-link {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  text-align: left;
  border-radius: 0;
  background: transparent;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.source-link::after {
  border: none;
}
.source-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}
.source-arrow {
  flex: none;
  color: var(--primary);
  font-size: 16px;
  line-height: 1.5;
}
.material-title {
  min-width: 0;
  color: var(--primary);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
}
.material-meta {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
.material-summary {
  margin-top: var(--space-1);
  color: var(--text);
  font-size: 15px;
  line-height: 1.65;
}
.remove-material {
  align-self: flex-end;
  margin: 0 calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0;
  color: var(--danger);
}
@media (min-width: 400px) {
  .material-card {
    padding-right: var(--space-5);
    padding-left: var(--space-5);
  }
}
</style>
