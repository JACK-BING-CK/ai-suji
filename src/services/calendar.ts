import type { ScheduleRow } from '../repositories/schedule'

export type { ScheduleRow }
export type CalendarMode = 'month' | 'week'
type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export interface ScheduleOccurrence {
  key: string
  schedule: ScheduleRow
  start_at: number
  end_at: number
  done: boolean
  overdue: boolean
}

export interface CalendarDay {
  date: number
  number: number
  inMonth: boolean
  isToday: boolean
  hasSchedules: boolean
}

const dayMs = 86_400_000

export function frequency(rule: string | null): Frequency | null {
  const value = rule
    ?.trim()
    .toUpperCase()
    .replace(/^RRULE:/, '')
  if (value === 'FREQ=DAILY') return 'DAILY'
  if (value === 'FREQ=WEEKLY') return 'WEEKLY'
  if (value === 'FREQ=MONTHLY') return 'MONTHLY'
  return null
}

export function repeatLabel(rule: string | null) {
  const repeat = frequency(rule)
  if (!repeat) return rule ? '自定义重复' : '不重复'
  return { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' }[repeat]
}

function midnight(at: number) {
  const date = new Date(at)
  return date.setHours(0, 0, 0, 0)
}

function addDays(at: number, offset: number) {
  const date = new Date(at)
  date.setDate(date.getDate() + offset)
  return date.setHours(0, 0, 0, 0)
}

// 用本地年月日算日差，跨夏令时的一天可能只有 23 小时。
function civilDay(date: Date) {
  const utc = new Date(0)
  return (
    utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate()) /
    dayMs
  )
}

function periodIndex(anchor: Date, at: number, repeat: Frequency | null) {
  if (!repeat) return 0
  const date = new Date(at)
  if (repeat === 'MONTHLY')
    return (
      (date.getFullYear() - anchor.getFullYear()) * 12 +
      date.getMonth() -
      anchor.getMonth()
    )
  return Math.floor(
    (civilDay(date) - civilDay(anchor)) / (repeat === 'WEEKLY' ? 7 : 1),
  )
}

function periodStart(
  anchor: Date,
  repeat: Frequency | null,
  index: number,
): number | null {
  if (index === 0) return anchor.getTime()
  if (!repeat || index < 0) return null
  const target = new Date(civilDay(anchor) * dayMs)
  if (repeat === 'MONTHLY') {
    target.setUTCMonth(target.getUTCMonth() + index)
    // 月末缺少同一日时跳过本月，例如 1 月 31 日之后是 3 月 31 日。
    if (target.getUTCDate() !== anchor.getDate()) return null
  } else {
    target.setUTCDate(
      target.getUTCDate() + index * (repeat === 'WEEKLY' ? 7 : 1),
    )
  }
  const local = new Date(anchor)
  local.setFullYear(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
  )
  // 跳过夏令时切换或时区变更造成的不存在的本地时间。
  if (
    local.getDate() !== target.getUTCDate() ||
    local.getHours() !== anchor.getHours() ||
    local.getMinutes() !== anchor.getMinutes()
  )
    return null
  return local.getTime()
}

export function occurrenceSlot(schedule: ScheduleRow, occurrenceStart: number) {
  return String(
    periodIndex(
      new Date(schedule.start_at),
      occurrenceStart,
      frequency(schedule.repeat_rule),
    ),
  )
}

export function matchesOccurrence(
  schedule: ScheduleRow,
  occurrenceStart: number,
) {
  if (!Number.isFinite(occurrenceStart) || occurrenceStart < schedule.start_at)
    return false
  const repeat = frequency(schedule.repeat_rule)
  const anchor = new Date(schedule.start_at)
  return (
    periodStart(
      anchor,
      repeat,
      periodIndex(anchor, occurrenceStart, repeat),
    ) === occurrenceStart
  )
}

export function isOccurrenceDone(
  schedule: ScheduleRow,
  occurrenceStart: number,
) {
  return occurrenceStart === schedule.start_at
    ? Boolean(schedule.done)
    : schedule.completed_slots.includes(
        occurrenceSlot(schedule, occurrenceStart),
      )
}

export function remapCompletedSlots(
  original: ScheduleRow,
  input: Pick<ScheduleRow, 'start_at' | 'repeat_rule'>,
): string[] {
  const previous = frequency(original.repeat_rule)
  const next = frequency(input.repeat_rule)
  if (!previous || !next) return []
  if (previous === next) return [...original.completed_slots]
  const oldAnchor = new Date(original.start_at)
  const newAnchor = new Date(input.start_at)
  const slots: string[] = []
  for (const slot of original.completed_slots) {
    const index = Number(slot)
    if (!Number.isSafeInteger(index) || index <= 0) continue
    const oldStart = periodStart(oldAnchor, previous, index)
    if (oldStart === null) continue
    const newIndex = periodIndex(newAnchor, oldStart, next)
    if (newIndex <= 0) continue
    const newStart = periodStart(newAnchor, next, newIndex)
    if (
      newStart !== null &&
      civilDay(new Date(newStart)) === civilDay(new Date(oldStart))
    )
      slots.push(String(newIndex))
  }
  return slots
}

export function moveCalendar(
  selectedAt: number,
  mode: CalendarMode,
  offset: number,
) {
  const at = midnight(selectedAt)
  if (mode === 'week') return addDays(at, 7 * offset)
  const date = new Date(at)
  const desiredDay = date.getDate()
  date.setMonth(date.getMonth() + offset + 1, 0)
  return midnight(date.setDate(Math.min(desiredDay, date.getDate())))
}

function monday(at: number) {
  return addDays(at, -((new Date(at).getDay() + 6) % 7))
}

function calendarDays(selectedAt: number, mode: CalendarMode, today: number) {
  const selected = new Date(midnight(selectedAt))
  const month = selected.getMonth()
  const first =
    mode === 'week' ? selected.getTime() : new Date(selected).setDate(1)
  const start = monday(first)
  const last =
    mode === 'week' ? first : new Date(selected).setMonth(month + 1, 0)
  const end = addDays(monday(last), 7)
  const days: CalendarDay[] = []
  for (let at = start; at < end; at = addDays(at, 1)) {
    const date = new Date(at)
    days.push({
      date: at,
      number: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: at === today,
      hasSchedules: false,
    })
  }
  const label = (at: number) => {
    const date = new Date(at)
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }
  const heading =
    mode === 'week'
      ? label(start) + ' – ' + label(addDays(end, -1))
      : `${selected.getFullYear()}年${month + 1}月`
  return { days, start, end, heading }
}

function chronological(a: ScheduleOccurrence, b: ScheduleOccurrence) {
  return (
    a.start_at - b.start_at ||
    b.schedule.priority - a.schedule.priority ||
    a.key.localeCompare(b.key)
  )
}

function recentOverdue(a: ScheduleOccurrence, b: ScheduleOccurrence) {
  return b.end_at - a.end_at || chronological(a, b)
}

export function buildCalendar(
  schedules: readonly ScheduleRow[],
  selectedAt: number,
  mode: CalendarMode,
  now: number,
  isDone?: (schedule: ScheduleRow, occurrenceStart: number) => boolean,
  todayLimit = 30,
) {
  const todayStart = midnight(now)
  const tomorrow = addDays(todayStart, 1)
  const selectedStart = midnight(selectedAt)
  const selectedEnd = addDays(selectedStart, 1)
  const grid = calendarDays(selectedAt, mode, todayStart)
  const selected: ScheduleOccurrence[] = []
  const todays: ScheduleOccurrence[] = []
  let past: ScheduleOccurrence[] = []
  const limit = Math.max(1, Math.floor(todayLimit))

  for (const schedule of schedules) {
    const duration = schedule.end_at - schedule.start_at
    if (
      schedule.deleted_at !== null ||
      duration <= 0 ||
      !Number.isFinite(duration)
    )
      continue
    const anchor = new Date(schedule.start_at)
    const repeat = frequency(schedule.repeat_rule)
    const completed = new Set(schedule.completed_slots)
    function instance(index: number, start: number): ScheduleOccurrence {
      const done = isDone
        ? isDone(schedule, start)
        : index === 0
          ? Boolean(schedule.done)
          : completed.has(String(index))
      const end = start + duration
      return {
        key: schedule.id + ':' + index,
        schedule,
        start_at: start,
        end_at: end,
        done,
        overdue: !done && end <= now,
      }
    }
    function overlapping(
      from: number,
      until: number,
      visit: (item: ScheduleOccurrence) => void,
    ) {
      if (schedule.start_at >= until) return
      const first = Math.max(0, periodIndex(anchor, from - duration, repeat))
      const last = periodIndex(anchor, until - 1, repeat)
      for (let index = first; index <= last; index++) {
        const start = periodStart(anchor, repeat, index)
        if (start !== null && start < until && start + duration > from)
          visit(instance(index, start))
      }
    }
    overlapping(grid.start, grid.end, (item) => {
      if (item.start_at < selectedEnd && item.end_at > selectedStart)
        selected.push(item)
      for (let i = 0; i < grid.days.length; i++) {
        const day = grid.days[i]
        const end = grid.days[i + 1]?.date ?? grid.end
        if (item.start_at < end && item.end_at > day.date)
          day.hasSchedules = true
      }
    })
    overlapping(todayStart, tomorrow, (item) => {
      if (!item.done) todays.push(item)
    })
    // 从最近逾期的一次向前找一页，旧系列不会从创建日开始全部实例化。
    const cutoff = todayStart - duration
    let found = 0
    for (
      let index = periodIndex(anchor, cutoff, repeat);
      index >= 0 && found <= limit;
      index--
    ) {
      const start = periodStart(anchor, repeat, index)
      if (start === null || start > cutoff) continue
      const item = instance(index, start)
      if (item.done) continue
      past.push(item)
      found++
    }
    if (past.length > limit + 1)
      past = past.sort(recentOverdue).slice(0, limit + 1)
  }
  const pending = todays.sort(chronological).concat(past.sort(recentOverdue))
  return {
    days: grid.days,
    heading: grid.heading,
    selected: selected.sort(chronological),
    today: pending.slice(0, limit),
    todayHasMore: pending.length > limit,
  }
}
