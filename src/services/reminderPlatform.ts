import type {
  NativeReminder,
  ReminderAction,
  ReminderPermissions,
  ReminderPlatform,
} from '../types/reminders'
// #ifdef APP-PLUS
// UTS 在 App-Plus 按设备选择 Android AlarmManager 或 iOS UserNotifications 的实现。
import { invokeReminder } from '@/uni_modules/suji-reminders'
// #endif

function invoke<T>(operation: string, payload: object = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    // #ifdef APP-PLUS
    try {
      invokeReminder(operation, JSON.stringify(payload), (raw: string) => {
        try {
          const result = JSON.parse(raw)
          if (result.ok !== true)
            throw new Error(result.error || '系统提醒操作失败。')
          resolve(result.data as T)
        } catch (cause) {
          reject(cause)
        }
      })
    } catch (cause) {
      reject(
        new Error('本机未能调用提醒模块，请使用包含本地提醒插件的安装包。', {
          cause,
        }),
      )
    }
    // #endif
    // #ifndef APP-PLUS
    reject(new Error('请在手机 App 中设置系统提醒。'))
    // #endif
  })
}

export const reminderPlatform: ReminderPlatform = {
  schedule: (row) => {
    // #ifdef APP-PLUS
    // 安卓锁屏时 JS 可能暂停；原生闹钟可在本应用数据库中立即提交延期操作。
    if (plus.os.name === 'Android')
      return invoke<void>('schedule', {
        ...row,
        databasePath: plus.io.convertLocalFileSystemURL('_doc/ai-suji.db'),
      })
    // #endif
    return invoke<void>('schedule', row)
  },
  cancel: (id) => invoke<void>('cancel', { id }),
  list: () => invoke<NativeReminder[]>('list'),
  actions: () => invoke<ReminderAction[]>('actions'),
  ack: (key) => invoke<void>('ack', { key }),
  permissions: () => invoke<ReminderPermissions>('permissions'),
  settings: (kind) => invoke<void>('settings', { kind }),
}
