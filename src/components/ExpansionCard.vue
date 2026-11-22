<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import LoadingButton from './LoadingButton.vue'
import IdeaMindMap from './IdeaMindMap.vue'
import {
  generateExpansion,
  loadExpansion,
  type Expansion,
  type ExpansionTemplate,
} from '@/services/expansion'
import { syncedDataRevision } from '@/services/sync'
import { useAuthStore } from '@/store/auth'

const props = defineProps<{
  /** 当前详情对应的已保存想法。 */
  ideaId: string
  /** 当前想法的原文，导图从中提取标题。 */
  original: string
  /** 想法所属的本地用户。 */
  owner: string
  /** 编辑原文时，保存后再生成思路。 */
  editing: boolean
}>()
const templates: { id: ExpansionTemplate; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'article', label: '文章' },
  { id: 'video', label: '视频' },
  { id: 'product', label: '产品' },
  { id: 'study', label: '学习' },
]
const auth = useAuthStore()
const templateIndex = ref(0)
const expansion = shallowRef<Expansion | null>(null)
const view = ref<'text' | 'map'>('text')
const generating = ref(false)
const offline = ref(false)
const networkHint = ref('')
const readError = ref('')
const generationError = ref('')
const ownerRevision = auth.revision
let mounted = false
let readVersion = 0
let networkVersion = 0

const buttonLabel = computed(() => {
  if (generationError.value) return '重试生成'
  return expansion.value ? '重新生成' : '生成思路'
})

function current() {
  return (
    mounted && auth.revision === ownerRevision && auth.user?.id === props.owner
  )
}

async function readSaved() {
  const version = ++readVersion
  try {
    const saved = await loadExpansion(props.owner, props.ideaId)
    if (current() && version === readVersion) {
      expansion.value = saved
      readError.value = ''
    }
  } catch (cause) {
    if (current() && version === readVersion)
      readError.value =
        cause instanceof Error ? cause.message : '读取已保存的思路失败。'
  }
}

async function generate() {
  if (
    generating.value ||
    offline.value ||
    props.editing ||
    !auth.token ||
    !current()
  )
    return
  generating.value = true
  generationError.value = ''
  try {
    const saved = await generateExpansion(
      props.owner,
      props.ideaId,
      templates[templateIndex.value].id,
    )
    if (!current()) return
    readVersion++
    if (!expansion.value || saved.updated_at >= expansion.value.updated_at)
      expansion.value = saved
    readError.value = ''
  } catch (cause) {
    if (current())
      generationError.value =
        cause instanceof Error ? cause.message : '生成思路失败，请重试。'
  } finally {
    if (current()) generating.value = false
  }
}

function networkChanged(status: { isConnected: boolean }) {
  networkVersion++
  offline.value = !status.isConnected
  networkHint.value = ''
}

async function checkNetwork() {
  const version = ++networkVersion
  try {
    const status = await uni.getNetworkType()
    if (mounted && version === networkVersion) {
      offline.value = status.networkType === 'none'
      networkHint.value = ''
    }
  } catch {
    if (mounted && version === networkVersion)
      networkHint.value = '暂时无法读取网络状态，请确认设备已联网。'
  }
}

onMounted(() => {
  mounted = true
  void readSaved()
  uni.onNetworkStatusChange(networkChanged)
  // #ifdef APP-PLUS
  // 原生 App 退到后台时可能错过网络切换，返回时重新确认。
  uni.onAppShow(checkNetwork)
  // #endif
  void checkNetwork()
})
watch(syncedDataRevision, readSaved)
onBeforeUnmount(() => {
  mounted = false
  uni.offNetworkStatusChange(networkChanged)
  // #ifdef APP-PLUS
  uni.offAppShow(checkNetwork)
  // #endif
})
</script>

<template>
  <view class="surface expansion-card">
    <view class="expansion-heading">
      <text class="section-title">AI 思路</text>
      <picker
        v-if="auth.token"
        mode="selector"
        :range="templates"
        range-key="label"
        :value="templateIndex"
        :disabled="generating"
        @change="templateIndex = Number($event.detail.value)"
      >
        <view
          class="template-choice"
          role="button"
          :aria-label="'选择模板，当前为' + templates[templateIndex].label"
        >
          <text>{{ templates[templateIndex].label }}模板</text>
          <view class="chevron" aria-hidden="true" />
        </view>
      </picker>
    </view>
    <view
      v-if="generating"
      class="skeleton"
      aria-label="正在生成思路"
      aria-busy="true"
    >
      <view v-for="n in 4" :key="n" class="skeleton-line" aria-hidden="true" />
    </view>
    <view v-if="expansion && !generating" class="view-switch">
      <button
        class="quiet-button"
        :aria-pressed="view === 'text'"
        :class="{ selected: view === 'text' }"
        @click="view = 'text'"
      >
        文字
      </button>
      <button
        class="quiet-button"
        :aria-pressed="view === 'map'"
        :class="{ selected: view === 'map' }"
        @click="view = 'map'"
      >
        思维导图
      </button>
    </view>
    <IdeaMindMap
      v-if="expansion && !generating && view === 'map'"
      :key="original + ':' + expansion.updated_at"
      :idea="original"
      :expansion="expansion"
    />
    <view v-else-if="expansion && !generating" class="expansion-result">
      <view class="result-section">
        <text class="result-label">背景</text>
        <text class="result-text" selectable>{{ expansion.background }}</text>
      </view>
      <view class="result-section">
        <text class="result-label">要点</text>
        <view
          v-for="(point, index) in expansion.points"
          :key="index"
          class="point"
        >
          <view class="point-marker" aria-hidden="true" />
          <text class="result-text" selectable>{{ point }}</text>
        </view>
      </view>
      <view class="result-section">
        <text class="result-label">风险</text>
        <text class="result-text" selectable>{{ expansion.risks }}</text>
      </view>
      <view class="result-section next-step">
        <text class="result-label">下一步</text>
        <text class="result-text" selectable>{{ expansion.next_steps }}</text>
      </view>
    </view>
    <view v-if="readError" class="error-text" role="alert">
      <text>{{ readError }}</text>
      <button class="quiet-button" @click="readSaved">重新读取</button>
    </view>
    <text v-if="generationError" class="error-text" role="alert">{{
      generationError
    }}</text>
    <text v-if="offline" class="muted-copy" role="status"
      >当前离线，联网后可生成思路。</text
    >
    <text v-else-if="networkHint" class="muted-copy" role="status">{{
      networkHint
    }}</text>
    <text v-else-if="editing && auth.token" class="muted-copy"
      >请先保存原文，再生成思路。</text
    >
    <LoadingButton
      v-if="auth.token"
      :label="buttonLabel"
      :loading="generating"
      :disabled="offline || editing"
      loading-text="正在生成思路…"
      :variant="expansion ? 'secondary' : 'primary'"
      @click="generate"
    />
    <navigator v-else class="quiet-button" url="/pages/auth/login"
      >登录后生成思路</navigator
    >
  </view>
</template>

<style scoped>
.expansion-card {
  margin-top: var(--space-3);
  padding: var(--space-4);
}
.expansion-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.expansion-heading .section-title {
  color: var(--primary);
}
.template-choice {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--primary);
  font-size: 14px;
  font-weight: 600;
}
.view-switch {
  display: inline-flex;
  gap: 2px;
  margin-bottom: var(--space-3);
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
}
.view-switch .quiet-button {
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}
.view-switch .selected {
  background: var(--primary-soft);
  color: var(--primary);
}
.chevron {
  width: 6px;
  height: 6px;
  margin: -3px 1px 0 var(--space-2);
  border: solid currentColor;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.expansion-result,
.skeleton {
  padding-bottom: var(--space-4);
}
.result-section {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.next-step {
  padding: var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: var(--primary-soft);
}
.result-label {
  display: block;
  margin-bottom: var(--space-1);
  font-size: 14px;
  font-weight: 700;
  color: var(--primary);
}
.result-text {
  display: block;
  min-width: 0;
  font-size: 15px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.point {
  display: flex;
  align-items: flex-start;
  margin-bottom: var(--space-1);
}
.point-marker {
  flex: none;
  width: 5px;
  height: 5px;
  margin: 10px var(--space-2) 0 1px;
  border-radius: 50%;
  background: var(--primary);
}
.skeleton-line {
  height: 12px;
  margin-top: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--border);
  animation: pulse 1.35s ease-in-out infinite alternate;
}
.skeleton-line:first-child {
  width: 32%;
}
.skeleton-line:last-child {
  width: 68%;
}
.muted-copy {
  margin: 0 0 var(--space-3);
}
@media (min-width: 400px) {
  .expansion-card {
    padding-right: var(--space-5);
    padding-left: var(--space-5);
  }
}
@keyframes pulse {
  to {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-line {
    animation: none;
  }
}
</style>
