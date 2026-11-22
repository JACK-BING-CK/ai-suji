<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { hasLegacyData, loginWithPhone } from '@/services/login'
import AppNavBar from '@/components/AppNavBar.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'

defineOptions({ name: 'AuthLoginPage' })

const appearance = useAppearanceStore()
const auth = useAuthStore()
const busy = ref(false)
const error = ref('')
const phone = ref('')
const code = ref('')
const legacy = ref(false)
const importLegacy = ref(false)
const valid = computed(
  () =>
    /^(?:1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(
      phone.value.trim().replace(/^\+86/, ''),
    ) && !!code.value.trim(),
)

onLoad(async () => {
  // #ifdef APP-PLUS
  // 旧版体验账号的数据仅存于手机 SQLite。
  try {
    legacy.value = await hasLegacyData()
  } catch {
    error.value = '旧版记录暂时无法读取，仍可登录。'
  }
  // #endif
})

async function enter() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (!auth.token) {
      if (!valid.value) throw new Error('请填写有效的手机号和验证码。')
      await loginWithPhone(phone.value, code.value, importLegacy.value)
      code.value = ''
    }
    if (getCurrentPages().length > 1) {
      await uni.navigateBack({ delta: 1 })
    } else {
      await uni.switchTab({ url: '/pages/mine/index' })
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="登录" back fallback-tab="/pages/mine/index" />
    <view class="page-body">
      <view class="surface login-card">
        <text class="login-title">{{
          auth.token ? '已登录' : '手机号登录'
        }}</text>
        <text class="login-note">{{
          auth.token
            ? auth.user?.nickname
            : '使用同一手机号，在设备间同步想法与日程。'
        }}</text>
        <template v-if="!auth.token">
          <text class="field-label">手机号</text>
          <input
            v-model="phone"
            class="login-input"
            aria-label="手机号"
            placeholder="请输入手机号"
            :maxlength="16"
            :disabled="busy"
          />
          <text class="field-label">验证码</text>
          <input
            v-model="code"
            class="login-input"
            aria-label="验证码"
            placeholder="请输入验证码"
            password
            confirm-type="done"
            :disabled="busy"
            @confirm="enter"
          />
          <checkbox-group
            v-if="legacy"
            @change="importLegacy = $event.detail.value.includes('import')"
            ><label class="login-note"
              ><checkbox value="import" :checked="importLegacy" />
              将这台设备的旧版体验记录导入此手机号</label
            ></checkbox-group
          >
        </template>
        <text v-if="error" class="error-text" role="alert">{{ error }}</text>
        <LoadingButton
          :label="auth.token ? '继续使用' : '登录'"
          :disabled="!auth.token && !valid"
          :loading="busy"
          loading-text="请稍候…"
          @click="enter"
        />
      </view>
    </view>
  </view>
</template>

<style scoped>
.login-card {
  display: flex;
  flex-direction: column;
  padding: var(--space-5);
  box-shadow: var(--shadow-card);
}
.login-title {
  color: var(--text);
  font-size: 23px;
  font-weight: 700;
  line-height: 1.45;
}
.field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.login-input {
  box-sizing: border-box;
  width: 100%;
  height: 50px;
  margin: var(--space-1) 0 var(--space-4);
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  background: var(--surface-subtle);
}
.login-input:focus-within {
  border-color: var(--primary);
}
.login-note {
  margin: var(--space-2) 0 var(--space-5);
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.7;
}
</style>
