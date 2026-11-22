<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue'
import { drawMindMap, layoutMindMap } from '@/services/mindMap'
import type { Expansion } from '@/services/expansion'

const props = defineProps<{
  /** 已保存想法的原文，用首个非空行的首句作为标题。 */
  idea: string
  /** 当前已保存的扩写，图中四个分支与这份数据一致。 */
  expansion: Expansion
}>()

const instance = getCurrentInstance()!
const canvasId = 'idea-map-' + instance.uid
const pixelRatio = uni.getSystemInfoSync().pixelRatio || 1
const map = computed(() => layoutMindMap(props.idea, props.expansion))
const size = computed(() => {
  const { width, height } = map.value
  // 旧款手机的 WebView 限制单个画布的大小；长文等比缩放，始终绘制完整导图。
  const scale = Math.min(
    1,
    4096 / Math.max(width, height),
    Math.sqrt(12000000 / (width * height)),
  )
  return {
    width: Math.ceil((width * scale) / pixelRatio),
    height: Math.ceil((height * scale) / pixelRatio),
    exportWidth: Math.ceil(width * scale),
    exportHeight: Math.ceil(height * scale),
  }
})
const image = ref('')
const error = ref('')
const drawing = ref(false)
const saving = ref(false)
let mounted = true

async function render() {
  if (drawing.value) return
  drawing.value = true
  error.value = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const path = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('绘图超时，请重试。')), 15000)
      // 等视图层确认画布实际尺寸后再画，避免原生桥导出默认大小的画布。
      uni
        .createSelectorQuery()
        .in(instance.proxy)
        .select('#' + canvasId)
        .boundingClientRect()
        .exec(() => {
          if (!mounted) return reject(new Error('已离开导图。'))
          try {
            const ctx = uni.createCanvasContext(canvasId, instance.proxy)
            ctx.scale(
              size.value.width / map.value.width,
              size.value.height / map.value.height,
            )
            drawMindMap(ctx, map.value)
            ctx.draw(false, () => {
              if (!mounted) return reject(new Error('已离开导图。'))
              uni.canvasToTempFilePath(
                {
                  canvasId,
                  fileType: 'png',
                  quality: 1,
                  width: size.value.width,
                  height: size.value.height,
                  destWidth: size.value.exportWidth,
                  destHeight: size.value.exportHeight,
                  success: ({ tempFilePath }) => resolve(tempFilePath),
                  fail: reject,
                },
                instance.proxy,
              )
            })
          } catch (cause) {
            reject(cause)
          }
        })
    })
    if (mounted) image.value = path
  } catch (cause) {
    if (mounted)
      error.value =
        cause instanceof Error ? cause.message : '导图绘制失败，请重试。'
  } finally {
    clearTimeout(timer)
    drawing.value = false
  }
}

async function preview() {
  if (!image.value) return
  try {
    await uni.previewImage({ current: image.value, urls: [image.value] })
  } catch {
    error.value = '大图打开失败，请重试。'
  }
}

async function saveImage() {
  if (!image.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    // #ifdef APP-PLUS
    // 原生端写入系统相册，权限由系统在首次保存时申请。
    await new Promise<void>((resolve, reject) =>
      uni.saveImageToPhotosAlbum({
        filePath: image.value,
        success: () => resolve(),
        fail: reject,
      }),
    )
    uni.showToast({ title: '导图已保存到相册', icon: 'none' })
    // #endif
    // #ifdef H5
    // 浏览器通过下载目录交付 PNG，没有写入手机相册的接口。
    const link = document.createElement('a')
    link.href = image.value
    link.download = 'AI速记-思维导图.png'
    document.body.appendChild(link)
    link.click()
    link.remove()
    // #endif
  } catch {
    error.value = '保存失败，请检查相册权限和剩余存储空间后重试。'
  } finally {
    saving.value = false
  }
}

onMounted(render)
onBeforeUnmount(() => {
  mounted = false
})
</script>

<template>
  <view class="map-view">
    <view class="map-canvas" aria-hidden="true">
      <canvas
        :id="canvasId"
        :canvas-id="canvasId"
        :hidpi="true"
        :style="{ width: size.width + 'px', height: size.height + 'px' }"
      />
    </view>
    <view
      v-if="image"
      class="map-preview"
      role="button"
      aria-label="查看完整思维导图"
      @click="preview"
    >
      <image
        :src="image"
        mode="widthFix"
        class="map-image"
        aria-label="想法标题与背景、要点、风险、下一步四个分支"
      />
    </view>
    <text v-if="drawing" class="muted-copy" role="status">正在绘制导图…</text>
    <text v-if="error" class="error-text" role="alert">{{ error }}</text>
    <view class="map-tools">
      <button v-if="!image && !drawing" class="quiet-button" @click="render">
        重新绘制
      </button>
      <template v-if="image">
        <button class="quiet-button" @click="preview">查看大图</button>
        <button class="quiet-button" :disabled="saving" @click="saveImage">
          <!-- #ifdef APP-PLUS -->
          {{ saving ? '正在保存…' : '保存到相册' }}
          <!-- #endif -->
          <!-- #ifdef H5 -->
          下载图片
          <!-- #endif -->
        </button>
      </template>
    </view>
  </view>
</template>

<style scoped>
.map-view {
  position: relative;
  padding: var(--space-2) 0 var(--space-3);
}
.map-canvas {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
}
.map-preview {
  display: block;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: #f6f4ed;
}
.map-image {
  display: block;
  width: 100%;
}
.map-tools {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
}
</style>
