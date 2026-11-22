import {
  appendStep,
  saveScheduleDrafts,
  stepOrder,
  updateStep,
  setScheduleDone as writeScheduleDone,
  setStepDone as writeStepDone,
  type ScheduleDraft,
  type StepInput,
  type WorkflowStep,
} from '../repositories/workflow'
import { scheduleReminder, updateRemindersAfterSave } from './reminderService'

export {
  listIdeaSchedules,
  listSteps,
  removeStep,
  reorderSteps,
  type ScheduleDraft,
  type StepInput,
  type WorkflowStep,
} from '../repositories/workflow'

export async function setScheduleDone(
  owner: string,
  id: string,
  done: boolean,
) {
  await writeScheduleDone(owner, id, done)
  await updateRemindersAfterSave()
}

export async function setStepDone(owner: string, id: string, done: boolean) {
  await writeStepDone(owner, id, done)
  await updateRemindersAfterSave()
}

function validateStep(input: StepInput): StepInput {
  const title = input.title.trim()
  if (!title) throw new Error('请输入步骤标题。')
  if (
    !Number.isInteger(input.duration_min) ||
    input.duration_min < 1 ||
    input.duration_min > 2147483647
  )
    throw new Error('预计时长必须是有效的正整数分钟数。')
  // MySQL 的 TEXT 最多容纳 65535 个 UTF-8 字节。
  if (encodeURIComponent(title).replace(/%[\dA-F]{2}/gi, 'x').length > 65535)
    throw new Error('步骤标题过长，请缩短后保存。')
  return {
    title,
    detail: input.detail.trim(),
    duration_min: input.duration_min,
  }
}

export async function addStep(owner: string, ideaId: string, input: StepInput) {
  return appendStep(owner, ideaId, validateStep(input))
}

export async function editStep(
  owner: string,
  stepId: string,
  input: StepInput,
) {
  return updateStep(owner, stepId, validateStep(input))
}

function validateTime(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    !Number.isFinite(new Date(value).getTime())
  )
    throw new Error('日程日期或时间无效，请重新选择。')
}

function scheduleId() {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto?.randomUUID === 'function'
  )
    return globalThis.crypto.randomUUID()
  // 部分原生逻辑层缺少 Web Crypto。预览用的 UUID 在重试确认时保持不变。
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const nibble = Math.floor(Math.random() * 16)
    return (char === 'x' ? nibble : (nibble & 3) | 8).toString(16)
  })
}

export function previewSchedule(
  steps: readonly WorkflowStep[],
  startAt: number,
): ScheduleDraft[] {
  if (!steps.length) throw new Error('请先添加流程步骤。')
  validateTime(startAt)
  let next = startAt
  return [...steps].sort(stepOrder).map((step) => {
    if (!Number.isSafeInteger(step.duration_min) || step.duration_min <= 0)
      throw new Error('步骤时长无效，请修改后再预览。')
    const start = next
    next = start + step.duration_min * 60_000
    validateTime(next)
    return {
      id: scheduleId(),
      step_id: step.id,
      step_version: step.updated_at,
      title: step.title,
      start_at: start,
      end_at: next,
    }
  })
}

export async function confirmSchedule(
  owner: string,
  ideaId: string,
  drafts: readonly ScheduleDraft[],
): Promise<string | undefined> {
  if (!drafts.length) throw new Error('请先预览日程。')
  const rows = drafts.map((row) => ({ ...row }))
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => row.step_id)).size !== rows.length
  )
    throw new Error('预览包含重复步骤，请重新预览。')
  for (const row of rows) {
    validateTime(row.start_at)
    validateTime(row.end_at)
    validateTime(row.start_at - 10 * 60_000)
    if (row.end_at <= row.start_at)
      throw new Error('结束时间必须晚于开始时间。')
  }
  const reminders = await saveScheduleDrafts(owner, ideaId, rows)
  try {
    for (const reminder of reminders) await scheduleReminder(reminder)
  } catch (cause) {
    return (
      '日程已保存。' +
      (cause instanceof Error
        ? cause.message
        : '系统提醒尚未登记，请检查权限。')
    )
  }
}
