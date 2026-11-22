export interface NativeReminder {
  id: string
  owner: string
  scheduleId: string
  at: number
  level: 0 | 1
  title: string
  body: string
  snoozeMin: number
  sound: string | null
  phase?: string
  databasePath?: string
}

export interface ReminderAction {
  key: string
  id: string
  owner: string
  scheduleId: string
  type: 'open' | 'done' | 'snooze'
  at: number
  scheduledAt: number
}

export interface ReminderPermissions {
  notifications: boolean
  exact: boolean | null
  battery: boolean | null
  fullscreen: boolean | null
}

export interface ReminderPlatform {
  schedule(reminder: NativeReminder): Promise<void>
  cancel(id: string): Promise<void>
  list(): Promise<NativeReminder[]>
  actions(): Promise<ReminderAction[]>
  ack(key: string): Promise<void>
  permissions(): Promise<ReminderPermissions>
  settings(kind: keyof ReminderPermissions): Promise<void>
}
