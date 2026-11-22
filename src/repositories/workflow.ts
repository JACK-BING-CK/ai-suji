import { withTransaction, type SqlExecutor } from './db'
import { uuid } from './fields'
import { ideaRepository } from './idea'
import { reminderRepository } from './reminder'
import { scheduleRepository, type ScheduleRow } from './schedule'
import { stepRepository } from './step'
import { notifyLocalWrite } from './syncQueue'

export type WorkflowStep = Awaited<ReturnType<typeof stepRepository.create>>
export type { ScheduleRow }
export type ScheduleInput = Pick<
  ScheduleRow,
  'title' | 'start_at' | 'end_at' | 'priority' | 'idea_id' | 'repeat_rule'
>
export type StepInput = Pick<WorkflowStep, 'title' | 'detail' | 'duration_min'>
export interface ScheduleDraft {
  id: string
  step_id: string
  step_version: number
  title: string
  start_at: number
  end_at: number
}

const steps = stepRepository.transaction
const schedules = scheduleRepository.transaction
const reminders = reminderRepository.transaction

async function write<T>(
  userId: string,
  task: (db: SqlExecutor, owner: string) => Promise<T>,
) {
  try {
    const owner = uuid(userId)
    const result = await withTransaction((db) => task(db, owner))
    notifyLocalWrite(owner)
    return result
  } catch (cause) {
    if (cause instanceof Error) throw cause
    throw new Error('保存流程更改失败，请重试。', { cause })
  }
}

export function stepOrder(a: WorkflowStep, b: WorkflowStep) {
  return a.sort_order - b.sort_order || a.id.localeCompare(b.id)
}

export async function listSteps(owner: string, ideaId: string) {
  const rows = await stepRepository.list(owner, { where: { idea_id: ideaId } })
  return rows.sort(stepOrder)
}

export async function listIdeaSchedules(owner: string, ideaId: string) {
  const rows = await scheduleRepository.list(owner, {
    where: { idea_id: ideaId },
  })
  return rows.sort(
    (a, b) => a.start_at - b.start_at || a.id.localeCompare(b.id),
  )
}

export function appendStep(owner: string, ideaId: string, input: StepInput) {
  return write(owner, async (db, user) => {
    const [row] = await db.query(
      'SELECT MAX(sort_order) AS last_order FROM step WHERE user_id = ? AND idea_id = ? AND deleted_at IS NULL',
      [user, uuid(ideaId)],
    )
    const order = Number(row?.last_order ?? -1) + 1
    if (order > 2147483647) throw new Error('步骤序号已达上限，请先重新排序。')
    return steps.create(db, user, {
      ...input,
      idea_id: ideaId,
      sort_order: order,
    })
  })
}

export async function updateStep(
  owner: string,
  stepId: string,
  input: StepInput,
) {
  const row = await stepRepository.update(owner, stepId, input)
  if (!row) throw new Error('步骤已删除或无法访问。')
  return row
}

export function removeStep(owner: string, stepId: string) {
  return write(owner, async (db, user) => {
    const id = uuid(stepId)
    if (!(await steps.get(db, user, id)))
      throw new Error('步骤已删除或无法访问。')
    const dependants = await steps.list(db, user, { where: { depends_on: id } })
    for (const row of dependants)
      await steps.update(db, user, row.id, { depends_on: null })
    // 已经确认的日程可继续使用，关联提醒仍跟随原日程。
    const linked = await schedules.list(db, user, { where: { step_id: id } })
    for (const row of linked)
      await schedules.update(db, user, row.id, { step_id: null })
    await steps.remove(db, user, id)
  })
}

export function reorderSteps(
  owner: string,
  ideaId: string,
  ids: readonly string[],
) {
  return write(owner, async (db, user) => {
    const rows = await steps.list(db, user, { where: { idea_id: ideaId } })
    const existing = new Map(rows.map((row) => [row.id, row]))
    if (ids.length !== rows.length || new Set(ids).size !== rows.length)
      throw new Error('步骤列表已更新，请重新排序。')
    for (const [index, id] of ids.entries()) {
      const row = existing.get(id)
      if (!row) throw new Error('步骤列表已更新，请重新排序。')
      if (row.sort_order !== index)
        await steps.update(db, user, id, { sort_order: index })
    }
  })
}

async function updateLinkedDone(
  db: SqlExecutor,
  owner: string,
  step: WorkflowStep,
  done: 0 | 1,
) {
  if (step.done !== done) await steps.update(db, owner, step.id, { done })
  const linked = await schedules.list(db, owner, {
    where: { step_id: step.id },
  })
  for (const schedule of linked)
    if (schedule.done !== done)
      await schedules.update(db, owner, schedule.id, { done })
}

export function setStepDone(owner: string, stepId: string, done: boolean) {
  return write(owner, async (db, user) => {
    const step = await steps.get(db, user, uuid(stepId))
    if (!step) throw new Error('步骤已删除或无法访问。')
    await updateLinkedDone(db, user, step, done ? 1 : 0)
  })
}

export function setScheduleDone(
  owner: string,
  scheduleId: string,
  done: boolean,
  instance?: { start_at: number; repeat_rule: string | null; slot: string },
) {
  return write(owner, async (db, user) => {
    const row = await schedules.get(db, user, uuid(scheduleId))
    if (!row) throw new Error('日程已删除或无法访问。')
    if (
      instance &&
      (row.start_at !== instance.start_at ||
        row.repeat_rule !== instance.repeat_rule)
    )
      throw new Error('重复规则或起始时间已更改，请重新选择日期。')
    if (instance && instance.slot !== '0') {
      const slots = new Set(row.completed_slots)
      if (slots.has(instance.slot) === done) return
      if (done) slots.add(instance.slot)
      else slots.delete(instance.slot)
      await schedules.update(db, user, row.id, {
        completed_slots: [...slots].sort((a, b) => Number(a) - Number(b)),
      })
      return
    }
    await setScheduleDoneInTransaction(db, user, row, done ? 1 : 0)
  })
}

export async function setScheduleDoneInTransaction(
  db: SqlExecutor,
  owner: string,
  row: ScheduleRow,
  done: 0 | 1,
) {
  const step = row.step_id && (await steps.get(db, owner, row.step_id))
  if (step) await updateLinkedDone(db, owner, step, done)
  else if (row.done !== done)
    await schedules.update(db, owner, row.id, { done })
}

async function currentSchedule(
  db: SqlExecutor,
  owner: string,
  original: ScheduleRow,
) {
  const row = await schedules.get(db, owner, uuid(original.id))
  if (!row) throw new Error('日程已删除或无法访问。')
  if (row.updated_at !== original.updated_at)
    throw new Error('日程已更新，请关闭编辑后重新打开。')
  return row
}

export function saveScheduleEdits(
  owner: string,
  input: ScheduleInput & { completed_slots?: string[] },
  original?: ScheduleRow,
) {
  return write(owner, async (db, user) => {
    if (!original) return schedules.create(db, user, input)
    const row = await currentSchedule(db, user, original)
    // 想法可能已软删除。未修改关联时不重新绑定；改选想法时解除原步骤的联动。
    const { idea_id, ...fields } = input
    const patch = {
      ...fields,
      ...(row.idea_id !== idea_id && { idea_id, step_id: null }),
    }
    const updated = await schedules.update(db, user, row.id, patch)
    if (!updated) throw new Error('日程已删除或无法访问。')
    const shift = updated.start_at - row.start_at
    if (shift) {
      const linked = await reminders.list(db, user, {
        where: { schedule_id: row.id },
      })
      for (const reminder of linked) {
        const at = reminder.remind_at + shift
        if (!Number.isFinite(new Date(at).getTime()))
          throw new Error('调整后的提醒时间无效。')
        await reminders.update(db, user, reminder.id, { remind_at: at })
      }
    }
    return updated
  })
}

export function deleteScheduleWithReminders(
  owner: string,
  original: ScheduleRow,
) {
  return write(owner, async (db, user) => {
    const row = await currentSchedule(db, user, original)
    const linked = await reminders.list(db, user, {
      where: { schedule_id: row.id },
    })
    for (const reminder of linked) await reminders.remove(db, user, reminder.id)
    await schedules.remove(db, user, row.id)
  })
}

export function saveScheduleDrafts(
  owner: string,
  ideaId: string,
  drafts: readonly ScheduleDraft[],
) {
  return write(owner, async (db, user) => {
    if (!(await ideaRepository.transaction.get(db, user, uuid(ideaId))))
      throw new Error('想法已删除或无法访问。')
    const current = (
      await steps.list(db, user, { where: { idea_id: ideaId } })
    ).sort(stepOrder)
    const created = []
    for (const [index, draft] of drafts.entries()) {
      const id = uuid(draft.id)
      const stored = await schedules.get(db, user, id)
      if (stored) {
        if (
          stored.idea_id !== ideaId ||
          stored.step_id !== draft.step_id ||
          stored.start_at !== draft.start_at ||
          stored.end_at !== draft.end_at
        )
          throw new Error('该预览的日程已经更改，请重新预览。')
        continue
      }
      const step = current[index]
      if (
        current.length !== drafts.length ||
        !step ||
        step.id !== draft.step_id ||
        step.updated_at !== draft.step_version ||
        step.title !== draft.title
      )
        throw new Error('步骤已更新，请重新预览日程。')
      await schedules.create(
        db,
        user,
        {
          idea_id: ideaId,
          step_id: step.id,
          title: step.title,
          start_at: draft.start_at,
          end_at: draft.end_at,
          done: step.done,
        },
        id,
      )
      created.push(
        await reminders.create(db, user, {
          schedule_id: id,
          remind_at: draft.start_at - 10 * 60_000,
          level: 0,
          enabled: 1,
        }),
      )
    }
    return created
  })
}
