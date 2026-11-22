const pad = (value: number) => String(value).padStart(2, '0')

export function calendarDate(value: number) {
  const date = new Date(value)
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-')
}

export function clockTime(value: number) {
  const date = new Date(value)
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

export function shortDay(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function timeRange(startAt: number, endAt: number) {
  const start = new Date(startAt)
  const end = new Date(endAt)
  const endDay =
    start.toDateString() === end.toDateString() ? '' : shortDay(end) + ' '
  return (
    shortDay(start) +
    ' ' +
    clockTime(startAt) +
    ' – ' +
    endDay +
    clockTime(endAt)
  )
}
