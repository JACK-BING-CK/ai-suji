import assert from 'node:assert/strict'
import process from 'node:process'
import test from 'node:test'
import {
  buildCalendar,
  isOccurrenceDone,
  matchesOccurrence,
  moveCalendar,
  occurrenceSlot,
  remapCompletedSlots,
  repeatLabel,
} from '../src/services/calendar.ts'

const at = (year, month, day, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime()

function schedule(id, start, overrides = {}) {
  return {
    id,
    title: id,
    user_id: 'owner',
    created_at: start,
    updated_at: start,
    deleted_at: null,
    idea_id: null,
    step_id: null,
    repeat_rule: null,
    start_at: start,
    end_at: start + 3_600_000,
    completed_slots: [],
    done: 0,
    priority: 0,
    ...overrides,
  }
}

test('月周切换与跨年导航保持同一天，星期一为首列', () => {
  const now = at(2026, 12, 31, 12)
  const friday = schedule('每周五', at(2026, 12, 25, 9), {
    repeat_rule: 'FREQ=WEEKLY',
  })
  const newYear = at(2027, 1, 1)
  const week = buildCalendar([friday], newYear, 'week', now)
  assert.deepEqual(
    [week.days.length, week.days[0].date, week.days.at(-1).date],
    [7, at(2026, 12, 28), at(2027, 1, 3)],
  )
  assert.deepEqual(
    week.days.filter((day) => day.hasSchedules).map((day) => day.date),
    [newYear],
  )
  assert.deepEqual(
    week.selected.map((item) => item.start_at),
    [at(2027, 1, 1, 9)],
  )
  const month = buildCalendar([friday], newYear, 'month', now)
  assert.equal(month.heading, '2027年1月')
  assert.deepEqual(month.selected, week.selected)
  assert.deepEqual(
    month.days
      .filter((day) => day.inMonth && day.hasSchedules)
      .map((day) => day.number),
    [1, 8, 15, 22, 29],
  )
  assert.deepEqual(
    month.days.filter((day) => day.isToday).map((day) => day.date),
    [at(2026, 12, 31)],
  )
  assert.equal(moveCalendar(at(2026, 12, 25), 'week', 1), newYear)
  assert.equal(moveCalendar(at(2026, 12, 31), 'month', 1), at(2027, 1, 31))
  assert.equal(moveCalendar(at(2028, 1, 31), 'month', 1), at(2028, 2, 29))
})

test('月末重复跳过缺日月份，闰日可展开且打卡独立', () => {
  const monthEnd = schedule('月末盘点', at(2026, 12, 31, 10), {
    repeat_rule: 'RRULE:FREQ=MONTHLY',
    done: 1,
    completed_slots: ['3'],
  })
  assert.equal(repeatLabel(monthEnd.repeat_rule), '每月')
  assert.equal(
    buildCalendar(
      [monthEnd],
      at(2027, 2, 28),
      'month',
      at(2027, 2, 28),
    ).days.some((day) => day.inMonth && day.hasSchedules),
    false,
  )
  for (const [start, index, done] of [
    [at(2026, 12, 31, 10), '0', true],
    [at(2027, 1, 31, 10), '1', false],
    [at(2027, 3, 31, 10), '3', true],
  ]) {
    assert.deepEqual(
      [
        matchesOccurrence(monthEnd, start),
        occurrenceSlot(monthEnd, start),
        isOccurrenceDone(monthEnd, start),
      ],
      [true, index, done],
    )
    assert.equal(
      buildCalendar([monthEnd], start, 'week', start).selected[0].done,
      done,
    )
  }
  for (const invalid of [
    at(2026, 11, 30, 10),
    at(2027, 2, 28, 10),
    at(2027, 3, 31, 11),
    at(2027, 3, 30, 10),
  ])
    assert.equal(matchesOccurrence(monthEnd, invalid), false)
  const leap = schedule('月报', at(2028, 1, 29, 9), {
    repeat_rule: 'FREQ=MONTHLY',
  })
  assert.equal(matchesOccurrence(leap, at(2028, 2, 29, 9)), true)
  assert.equal(matchesOccurrence(leap, at(2029, 2, 28, 9)), false)
})

test('跨午夜的生成日程与手动重复日程同时打点，结束整点不占下一天', () => {
  const rows = [
    schedule('关联步骤', at(2026, 12, 31, 23), {
      step_id: 'step',
      end_at: at(2027, 1, 1, 1),
    }),
    schedule('午夜截止', at(2026, 12, 31, 22), { end_at: at(2027, 1, 1) }),
    schedule('跨年重复', at(2026, 12, 30, 9), { repeat_rule: 'FREQ=DAILY' }),
    schedule('已删除', at(2027, 1, 1, 9), { deleted_at: at(2027, 1, 2) }),
  ]
  const first = at(2027, 1, 1, 9, 30)
  const result = buildCalendar(rows, first, 'week', first)
  assert.deepEqual(
    result.selected.map((item) => item.schedule.id),
    ['关联步骤', '跨年重复'],
  )
  assert.deepEqual(
    result.selected.map((item) => item.overdue),
    [true, false],
  )
  assert.deepEqual(
    buildCalendar([rows[1]], first, 'week', first)
      .days.filter((day) => day.hasSchedules)
      .map((day) => day.date),
    [at(2026, 12, 31)],
  )
})

test('今日待办与正在查看的日期独立，保留过期待办、忽略已打卡，旧系列按页加载', () => {
  const now = at(2027, 1, 2, 12)
  const daily = schedule('午间记录', at(2026, 12, 31, 11), {
    repeat_rule: 'FREQ=DAILY',
    completed_slots: ['1'],
  })
  const upcoming = schedule('稍后', at(2027, 1, 2, 15))
  const prior = schedule('过期', at(2026, 12, 20, 8))
  const done = schedule('完成', at(2027, 1, 2, 9), { done: 1 })
  const feb = at(2027, 2, 1)
  const rows = [prior, upcoming, daily, done]
  const list = buildCalendar(rows, feb, 'month', now).today
  assert.deepEqual(
    list.map((item) => [item.schedule.id, item.overdue, item.start_at]),
    [
      ['午间记录', true, at(2027, 1, 2, 11)],
      ['稍后', false, upcoming.start_at],
      ['午间记录', true, daily.start_at],
      ['过期', true, prior.start_at],
    ],
  )
  const series = schedule('多年每日', at(1970, 1, 1, 10), {
    repeat_rule: 'FREQ=DAILY',
  })
  let visits = 0
  const page = buildCalendar(
    [series],
    feb,
    'month',
    now,
    () => {
      visits++
      return false
    },
    3,
  )
  assert.equal(page.todayHasMore, true)
  assert.deepEqual(
    page.today.map((item) => item.start_at),
    [at(2027, 1, 2, 10), at(2027, 1, 1, 10), at(2026, 12, 31, 10)],
  )
  assert.ok(visits < 60)
  const expanded = buildCalendar([series], feb, 'week', now, undefined, 5)
  assert.deepEqual(expanded.today.slice(0, 3), page.today)
  assert.equal(expanded.today.at(-1).start_at, at(2026, 12, 29, 10))
})

test('夏令时切换保持本地起始钟点，跳过不存在的时间', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const daily = schedule('本地九点', at(2027, 3, 13, 9), {
      repeat_rule: 'FREQ=DAILY',
    })
    assert.equal(at(2027, 3, 14, 9) - daily.start_at, 23 * 3_600_000)
    assert.equal(matchesOccurrence(daily, at(2027, 3, 14, 9)), true)
    assert.equal(occurrenceSlot(daily, at(2027, 3, 15, 9)), '2')
    const gap = schedule('两点半', at(2027, 3, 13, 2, 30), {
      repeat_rule: 'FREQ=DAILY',
    })
    const missing = buildCalendar(
      [gap],
      at(2027, 3, 14),
      'week',
      at(2027, 3, 14, 12),
    )
    assert.equal(missing.selected.length, 0)
    assert.equal(matchesOccurrence(gap, at(2027, 3, 15, 2, 30)), true)
    const fall = schedule('每周九点', at(2027, 10, 31, 9), {
      repeat_rule: 'FREQ=WEEKLY',
    })
    assert.equal(at(2027, 11, 7, 9) - fall.start_at, 169 * 3_600_000)
    assert.equal(matchesOccurrence(fall, at(2027, 11, 7, 9)), true)
    process.env.TZ = 'America/Santiago'
    const morning = schedule('午夜后', at(2026, 9, 7, 0, 15))
    const afterMidnightJump = buildCalendar(
      [morning],
      at(2026, 9, 7),
      'month',
      at(2026, 9, 7, 2),
    )
    const cell = afterMidnightJump.days.find((day) => day.isToday)
    assert.equal(cell.date, at(2026, 9, 7))
    assert.equal(cell.hasSchedules, true)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('改全部时同频率保留打卡，改频率保留日期交集，关闭重复只保留首条状态', () => {
  const daily = schedule('每日复习', at(2027, 1, 1, 9), {
    repeat_rule: 'FREQ=DAILY',
    completed_slots: ['1', '7', '9', '14'],
    done: 1,
  })
  assert.deepEqual(
    remapCompletedSlots(daily, {
      start_at: at(2027, 1, 1, 17),
      repeat_rule: 'RRULE:FREQ=DAILY',
    }),
    daily.completed_slots,
  )
  assert.deepEqual(
    remapCompletedSlots(daily, {
      start_at: at(2027, 1, 1, 17),
      repeat_rule: 'FREQ=WEEKLY',
    }),
    ['1', '2'],
  )
  assert.deepEqual(
    remapCompletedSlots(daily, {
      start_at: at(2027, 1, 8, 9),
      repeat_rule: 'FREQ=WEEKLY',
    }),
    ['1'],
  )
  assert.deepEqual(
    remapCompletedSlots(daily, { start_at: daily.start_at, repeat_rule: null }),
    [],
  )
  assert.deepEqual(
    [daily.done, daily.completed_slots],
    [1, ['1', '7', '9', '14']],
  )
})
