declare module '@/uni_modules/suji-reminders' {
  export function invokeReminder(
    operation: string,
    payload: string,
    callback: (result: string) => void,
  ): void
}
