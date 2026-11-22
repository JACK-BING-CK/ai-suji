// 已发布迁移保持原样；新版本追加在数组末尾，下标加一即 user_version。
const commonV1 = `
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER`

export const migrations: readonly (readonly string[])[] = [
  [
    `CREATE TABLE idea (
      ${commonV1},
      content TEXT NOT NULL CHECK (length(content) <= 2000),
      source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice', 'photo', 'share')),
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'processed', 'archived')),
      UNIQUE (user_id, id)
    )`,
    `CREATE TABLE expansion (
      ${commonV1},
      idea_id TEXT NOT NULL,
      background TEXT NOT NULL,
      points TEXT NOT NULL,
      risks TEXT NOT NULL,
      next_steps TEXT NOT NULL,
      model TEXT NOT NULL,
      FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id)
    )`,
    'CREATE UNIQUE INDEX uq_expansion_active_idea ON expansion (user_id, idea_id) WHERE deleted_at IS NULL',
    'CREATE INDEX idx_expansion_user_idea ON expansion (user_id, idea_id)',
    `CREATE TABLE material (
      ${commonV1},
      idea_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_name TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id)
    )`,
    'CREATE INDEX idx_material_user_idea ON material (user_id, idea_id)',
    `CREATE TABLE step (
      ${commonV1},
      idea_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      duration_min INTEGER NOT NULL CHECK (typeof(duration_min) = 'integer' AND duration_min > 0),
      sort_order INTEGER NOT NULL,
      depends_on TEXT,
      done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      UNIQUE (user_id, id),
      FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id),
      FOREIGN KEY (user_id, depends_on) REFERENCES step (user_id, id)
    )`,
    `CREATE TABLE schedule (
      ${commonV1},
      idea_id TEXT,
      step_id TEXT,
      title TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      repeat_rule TEXT,
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
      done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      UNIQUE (user_id, id),
      FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id),
      FOREIGN KEY (user_id, step_id) REFERENCES step (user_id, id)
    )`,
    `CREATE TABLE reminder (
      ${commonV1},
      schedule_id TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0, 1)),
      sound TEXT,
      snooze_min INTEGER NOT NULL DEFAULT 10,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      native_id TEXT,
      FOREIGN KEY (user_id, schedule_id) REFERENCES schedule (user_id, id)
    )`,
    'CREATE INDEX idx_reminder_user_schedule ON reminder (user_id, schedule_id)',
    `CREATE TABLE usage_log (
      ${commonV1},
      type TEXT NOT NULL CHECK (type IN ('expand', 'breakdown', 'research', 'asr')),
      tokens INTEGER NOT NULL CHECK (typeof(tokens) = 'integer' AND tokens >= 0)
    )`,
    'CREATE INDEX idx_usage_log_user ON usage_log (user_id)',
  ],
  [
    `CREATE TABLE sync_outbox (
      user_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
      version INTEGER NOT NULL, PRIMARY KEY (user_id, table_name, row_id)
    )`,
    'CREATE TABLE sync_cursor (user_id TEXT PRIMARY KEY NOT NULL, cursor INTEGER NOT NULL)',
    // 旧版尚未联网同步，首次升级时将六表的现有行（包括软删除）全部入队。
    ...['idea', 'expansion', 'material', 'step', 'schedule', 'reminder'].map(
      (table) =>
        `INSERT INTO sync_outbox (user_id, table_name, row_id, version)
         SELECT user_id, '${table}', id, updated_at FROM ${table}`,
    ),
  ],
  [
    "ALTER TABLE schedule ADD COLUMN completed_slots TEXT NOT NULL DEFAULT '[]'",
  ],
]
