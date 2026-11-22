import {
  deleteScheduleWithReminders,
  saveScheduleEdits,
  setScheduleDone,
  type ScheduleInput,
  type ScheduleRow,
} from '../repositories/workflow'
import {
  frequency,
  matchesOccurrence,
  occurrenceSlot,
  remapCompletedSlots,
} from './calendar'
import { updateRemindersAfterSave } from './reminderService'

export type { ScheduleInput, ScheduleRow }

export async function saveSchedule(
  owner: string,
  input: ScheduleInput,
  original?: ScheduleRow,
) {
  const title = input.title.trim()
  if (!title) throw new Error('请输入日程标题。')
  if (encodeURIComponent(title).replace(/%[\dA-F]{2}/gi, 'x').length > 65535)
    throw new Error('日程标题过长，请缩短后保存。')
  if (
    ![input.start_at, input.end_at].every(
      (value) =>
        Number.isSafeInteger(value) &&
        Number.isFinite(new Date(value).getTime()),
    )
  )
    throw new Error('请选择有效的开始和结束时间。')
  if (input.end_at <= input.start_at)
    throw new Error('结束时间必须晚于开始时间。')
  const repeat = frequency(input.repeat_rule)
  if (input.repeat_rule !== null && !repeat)
    throw new Error('请选择不重复、每天、每周或每月。')
  const repeat_rule = repeat ? 'FREQ=' + repeat : null
  const changes = { ...input, title, repeat_rule }
  const completed_slots =
    original && original.repeat_rule !== repeat_rule
      ? remapCompletedSlots(original, changes)
      : undefined
  const saved = await saveScheduleEdits(
    owner,
    { ...changes, completed_slots },
    original,
  )
  if (original) await updateRemindersAfterSave()
  return saved
}

export async function deleteSchedule(owner: string, original: ScheduleRow) {
  await deleteScheduleWithReminders(owner, original)
  await updateRemindersAfterSave()
}

export async function setOccurrenceDone(
  owner: string,
  original: ScheduleRow,
  startAt: number,
  done: boolean,
) {
  if (!matchesOccurrence(original, startAt))
    throw new Error('该日程实例已失效，请重新选择日期。')
  await setScheduleDone(owner, original.id, done, {
    start_at: original.start_at,
    repeat_rule: original.repeat_rule,
    slot: occurrenceSlot(original, startAt),
  })
  await updateRemindersAfterSave()
}
