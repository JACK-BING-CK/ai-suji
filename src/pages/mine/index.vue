<script setup lang="ts">
import { ref } from 'vue'
import AppNavBar from '@/components/AppNavBar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import LoadingButton from '@/components/LoadingButton.vue'
import { useAppearanceStore } from '@/store/appearance'
import { useAuthStore } from '@/store/auth'
import { checkService } from '@/services/health'
import { syncMessage } from '@/services/sync'

const appearance = useAppearanceStore()
const auth = useAuthStore()
const confirmLogout = ref(false)
const checking = ref(false)
const connected = ref(false)
const error = ref('')
const accountError = ref('')
async function check() {
  if (checking.value) return
  checking.value = true
  connected.value = false
  error.value = ''
  // 即时响应也让用户能看清按钮的反馈，网络请求本身立即发出。
  const feedback = new Promise<void>((resolve) => setTimeout(resolve, 350))
  try {
    await checkService()
    await feedback
    connected.value = true
  } catch (cause) {
    await feedback
    error.value = cause instanceof Error ? cause.message : '连接失败，请重试。'
  } finally {
    checking.value = false
  }
}
function logout() {
  confirmLogout.value = false
  try {
    auth.logout()
    accountError.value = ''
  } catch (cause) {
    accountError.value =
      cause instanceof Error ? cause.message : '退出失败，请重试。'
  }
}
</script>
<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="我的" />
    <view class="page-body">
      <view class="surface account-card">
        <view class="account-icon" aria-hidden="true"
          ><view class="person-head" /><view class="person-body"
        /></view>
        <view class="account-summary">
          <text class="section-title">{{
            auth.user?.nickname || '尚未登录'
          }}</text>
          <text class="muted-copy">{{
            auth.user
              ? auth.token
                ? '已登录'
                : '本机测试账号'
              : '登录后查看自己的想法与日程'
          }}</text>
        </view>
        <button
          v-if="auth.token"
          class="quiet-button account-action"
          @click="confirmLogout = true"
        >
          退出
        </button>
        <navigator
          v-else
          class="quiet-button account-action"
          url="/pages/auth/login"
          >登录 ›</navigator
        >
      </view>
      <text v-if="auth.token && syncMessage" class="error-text" role="status">{{
        syncMessage
      }}</text>
      <text v-if="accountError" class="error-text" role="alert">{{
        accountError
      }}</text>
      <view class="surface connection reminder-card">
        <navigator class="reminder-link" url="/pages/reminders/permissions">
          <view
            ><text class="section-title">提醒权限</text>
            <text class="muted-copy">检查本机设置，让日程按时提醒。</text></view
          >
          <text class="reminder-arrow" aria-hidden="true">›</text>
        </navigator>
      </view>
      <view class="surface connection">
        <view class="connection-heading">
          <text class="section-title">服务连接</text>
          <text v-if="connected" class="connection-badge" role="status"
            >已连接</text
          >
        </view>
        <text v-if="!connected" class="muted-copy">{{
          checking ? '正在连接后端服务…' : '检查设备与后端服务的连接状态'
        }}</text>
        <text v-if="error" class="error-text" role="alert">{{ error }}</text>
        <LoadingButton
          :label="error ? '重新检查' : '检查连接'"
          loading-text="正在检查…"
          variant="secondary"
          :loading="checking"
          @click="check"
        />
      </view>
    </view>
    <ConfirmDialog
      :visible="confirmLogout"
      title="退出登录？"
      message="已保存的想法会保留在本机。未保存的草稿将清空。"
      confirm-text="退出"
      destructive
      @confirm="logout"
      @cancel="confirmLogout = false"
    />
  </view>
</template>
<style scoped>
.account-card {
  display: flex;
  align-items: center;
  padding: var(--space-4);
  gap: var(--space-3);
  background: linear-gradient(140deg, var(--primary-soft), var(--surface) 68%);
  box-shadow: var(--shadow-card);
}
.account-summary {
  flex: 1;
  min-width: 0;
}
.account-icon {
  width: 50px;
  height: 50px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--primary);
}
.person-head {
  width: 9px;
  height: 9px;
  border: 1.7px solid currentColor;
  border-radius: 50%;
}
.person-body {
  width: 19px;
  height: 8px;
  border: 1.7px solid currentColor;
  border-radius: 12px 12px 4px 4px;
  margin-top: 3px;
}
.account-summary .section-title {
  overflow-wrap: anywhere;
}
.account-action {
  flex: none;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  white-space: nowrap;
}
.connection {
  padding: var(--space-4);
  margin-top: var(--space-3);
}
.reminder-card {
  padding: 0;
}
.connection-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.connection-badge {
  padding: 3px 8px;
  color: var(--success);
  background: var(--success-soft);
  border-radius: 99px;
  font-size: 12px;
  white-space: nowrap;
}
.connection .muted-copy {
  margin-bottom: 0;
}
.connection :deep(.loading-button) {
  margin-top: var(--space-4);
}
.reminder-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-4);
  gap: var(--space-3);
  color: var(--primary);
}
.reminder-arrow {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  text-align: center;
  line-height: 30px;
  font-size: 24px;
  border-radius: var(--radius-sm);
  background: var(--primary-soft);
}
.reminder-link .muted-copy {
  margin-bottom: 0;
}
</style>
