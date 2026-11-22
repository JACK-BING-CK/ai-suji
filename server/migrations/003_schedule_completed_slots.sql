-- 旧日程只有首次完成状态，后续实例从空打卡记录开始。
SET @add_slots = IF(
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'schedule' AND column_name = 'completed_slots'),
  'SELECT 1',
  'ALTER TABLE schedule ADD COLUMN completed_slots JSON NOT NULL DEFAULT (JSON_ARRAY())'
);
PREPARE add_slots FROM @add_slots;
EXECUTE add_slots;
DEALLOCATE PREPARE add_slots;
