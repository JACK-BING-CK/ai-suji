-- 两端小组件共用。输入当前 UTC 毫秒和当前账号，按日程页「今日待办」的顺序取前三条。
WITH RECURSIVE
clock AS (
  SELECT date(?1 / 1000.0, 'unixepoch', 'localtime') AS today
),
bounds AS (
  SELECT today, strftime('%s', today, 'utc') * 1000 AS day_start,
         strftime('%s', today, '+1 day', 'utc') * 1000 AS tomorrow FROM clock
),
anchors AS (
  SELECT s.*, end_at - start_at AS duration,
         datetime(start_at / 1000.0, 'unixepoch', 'localtime') AS anchor,
         replace(upper(trim(coalesce(repeat_rule, ''))), 'RRULE:', '') AS rule,
         today, day_start, tomorrow,
         date((day_start - (end_at - start_at)) / 1000.0, 'unixepoch', 'localtime') AS cutoff
  FROM widget_schedule s CROSS JOIN bounds
  WHERE user_id = ?2 AND end_at > start_at AND start_at < tomorrow
),
periods AS (
  SELECT *,
    CASE rule WHEN 'FREQ=MONTHLY' THEN
      12 * (strftime('%Y', today) - strftime('%Y', anchor)) + strftime('%m', today) - strftime('%m', anchor)
      WHEN 'FREQ=WEEKLY' THEN CAST((julianday(today) - julianday(date(anchor))) / 7 AS INTEGER)
      WHEN 'FREQ=DAILY' THEN CAST(julianday(today) - julianday(date(anchor)) AS INTEGER)
      ELSE 0 END AS last_slot,
    CASE rule WHEN 'FREQ=MONTHLY' THEN
      12 * (strftime('%Y', cutoff) - strftime('%Y', anchor)) + strftime('%m', cutoff) - strftime('%m', anchor)
      WHEN 'FREQ=WEEKLY' THEN CAST((julianday(cutoff) - julianday(date(anchor))) / 7 AS INTEGER)
      WHEN 'FREQ=DAILY' THEN CAST(julianday(cutoff) - julianday(date(anchor)) AS INTEGER)
      ELSE 0 END AS cutoff_slot
  FROM anchors
),
-- 回溯窗口包含全部已完成槽，再为月末缺日和夏令时跳时留出间隔。
slots(id, n, first_slot) AS (
  SELECT id, last_slot, max(0, cutoff_slot - 2 * (5 + length(completed_slots) -
    length(replace(completed_slots, ',', '')))) FROM periods
  UNION ALL SELECT id, n - 1, first_slot FROM slots WHERE n > first_slot
),
days AS (
  SELECT p.*, n,
    CASE rule WHEN 'FREQ=MONTHLY' THEN date(anchor, 'start of month', '+' || n || ' months',
                                            '+' || (strftime('%d', anchor) - 1) || ' days')
      WHEN 'FREQ=WEEKLY' THEN date(anchor, '+' || (7 * n) || ' days')
      ELSE date(anchor, '+' || n || ' days') END AS occurrence_day
  FROM slots JOIN periods p USING (id)
  WHERE (n = 0 AND done = 0) OR (n > 0 AND instr(completed_slots, ',' || n || ',') = 0)
),
wall_times AS (
  SELECT *, occurrence_day || ' ' || time(anchor) AS wall FROM days
  WHERE rule <> 'FREQ=MONTHLY' OR strftime('%d', occurrence_day) = strftime('%d', anchor)
),
-- 在本地时间回拨时选择较早的那个时刻，与 JS Date 一致；不存在的时刻不生成实例。
offsets AS (
  SELECT *, strftime('%s', wall, '-1 day', 'utc') + 86400 AS early,
            strftime('%s', wall, '+1 day', 'utc') - 86400 AS late FROM wall_times
),
occurrences AS (
  SELECT *, CASE WHEN n = 0 THEN start_at ELSE (CASE
    WHEN datetime(early, 'unixepoch', 'localtime') = wall THEN early
    WHEN datetime(late, 'unixepoch', 'localtime') = wall THEN late END) * 1000
    + ((start_at % 1000 + 1000) % 1000) END AS starts FROM offsets
),
ranked AS (
  SELECT *, starts + duration > day_start AS is_today FROM occurrences WHERE starts < tomorrow
)
SELECT id, title, starts AS start_at FROM ranked
ORDER BY is_today DESC,
         CASE WHEN is_today = 0 THEN starts + duration END DESC,
         starts, priority DESC, id || ':' || n LIMIT 3
