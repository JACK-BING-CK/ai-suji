<script setup lang="ts">
import { ref } from 'vue'
import AppNavBar from '@/components/AppNavBar.vue'
import { useAppearanceStore } from '@/store/appearance'

defineOptions({ name: 'ReminderBrandGuidePage' })
const appearance = useAppearanceStore()
const guides = [
  // 华为 EMUI / HarmonyOS 4 支持页：https://consumer.huawei.com/cn/support/content/zh-cn00428704/
  {
    name: '华为',
    image: 'huawei',
    alt: '手动管理示意，允许自启动和允许后台活动均已开启',
    instructions: [
      '打开手机设置，搜索「应用启动管理」。',
      '找到 AI速记，关闭「自动管理」，进入手动管理。',
      '打开「允许自启动」和「允许后台活动」，再确认。',
      '长按桌面的 AI速记图标，进入「应用信息」→「通知管理」→「日程闹钟」。开启「允许通知」，勾选「横幅」和「锁屏通知」。如有重要性选项，设为高。',
    ],
    note: '适用于提供 Android 应用启动管理的 EMUI 和 HarmonyOS 版本。',
  },
  // 小米官方 14T 指南：https://www.mi.com/uk/support/faq/details/KA-507608/
  {
    name: '小米',
    image: 'xiaomi',
    alt: '后台自启动示意，AI速记开关已开启',
    instructions: [
      '进入「设置」中的「应用」或「应用设置」。',
      '打开「权限管理」中的「后台自启动」。部分版本在「应用」下直接显示此项。',
      '在列表中找到 AI速记，打开旁边的开关。',
    ],
    note: '在设置搜索栏输入「自启动」，也能定位入口。',
  },
  // OPPO 机型后台设置图解：https://consumer.huawei.com/cn/support/content/zh-cn15848664/
  {
    name: 'OPPO',
    image: 'oppo',
    alt: '应用耗电管理示意，允许完全后台行为和允许应用自启动均已开启',
    instructions: [
      '打开设置，搜索「应用耗电管理」。',
      '选择 AI速记，打开「允许后台运行」或「允许完全后台行为」。',
      '同页如有「允许应用自启动」，一并开启。',
    ],
    note: 'ColorOS 各版本的耗电管理入口和选项名称可能不同。',
  },
  // vivo 客服指引：https://kefu.vivo.com.cn/robot/imgmsgData/2616a9cd7cd64a5083a264d16e5767da/index_1.html
  {
    name: 'vivo',
    image: 'vivo',
    alt: '后台耗电管理示意，AI速记已选择允许后台高耗电',
    instructions: [
      '打开「设置」中的「电池」，进入「后台耗电管理」或「后台高耗电」。',
      '选择 AI速记，设置为「允许后台高耗电」。',
      '在「应用与权限」的权限管理中找到「自启动」，开启 AI速记。',
    ],
    note: '可在设置搜索栏输入「后台耗电」或「自启动」。',
  },
]
const index = ref(0)
</script>
<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="后台运行设置指引" back fallback-tab="/pages/mine/index" />
    <view class="page-body">
      <view class="brands" aria-label="手机品牌">
        <button
          v-for="(guide, i) in guides"
          :key="guide.name"
          class="brand"
          :class="{ selected: i === index }"
          :aria-pressed="i === index"
          @click="index = i"
        >
          {{ guide.name }}
        </button>
      </view>
      <view class="surface instructions">
        <text class="section-title">{{ guides[index].name }}后台设置</text>
        <view class="steps">
          <view
            v-for="(step, i) in guides[index].instructions"
            :key="step"
            class="step"
          >
            <text class="number">{{ i + 1 }}</text><text>{{ step }}</text>
          </view>
        </view>
        <image
          class="illustration"
          mode="widthFix"
          :src="'/static/reminders/' + guides[index].image + '.png'"
          :alt="guides[index].alt"
          :aria-label="guides[index].alt"
        />
        <text class="muted-copy">设置示意图。{{ guides[index].note }}</text>
      </view>
    </view>
  </view>
</template>
<style scoped>
.brands {
  display: flex;
  gap: var(--space-1);
  margin: 0 0 var(--space-4);
}
.brand {
  flex: 1;
  min-width: 0;
  padding: 0;
  margin: 0;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--surface);
  font-size: 15px;
}
.brand::after {
  border: none;
}
.brand.selected {
  color: var(--on-primary);
  background: var(--primary);
  border-color: var(--primary);
  font-weight: 650;
}
.instructions {
  padding: var(--space-4);
}
.steps {
  margin: var(--space-3) 0;
}
.step {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  line-height: 1.65;
  font-size: 15px;
}
.number {
  color: var(--primary);
  font-weight: 650;
}
.illustration {
  display: block;
  width: 100%;
  height: auto;
  max-width: 440px;
  border-radius: var(--radius-md);
}
</style>
