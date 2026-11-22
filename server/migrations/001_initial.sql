CREATE TABLE IF NOT EXISTS `user` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  phone VARCHAR(32) NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  status TINYINT NOT NULL DEFAULT 1 CHECK (status IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS idea (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content TEXT NOT NULL CHECK (CHAR_LENGTH(content) <= 2000),
  source VARCHAR(8) NOT NULL DEFAULT 'text' CHECK (source IN ('text','voice','photo','share')),
  tags JSON NOT NULL DEFAULT (JSON_ARRAY()) CHECK (JSON_TYPE(tags) = 'ARRAY'),
  status VARCHAR(16) NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','processed','archived')),
  UNIQUE KEY uq_idea_owner_id (user_id, id),
  FOREIGN KEY (user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS expansion (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  idea_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  background LONGTEXT NOT NULL,
  points JSON NOT NULL CHECK (JSON_TYPE(points) = 'ARRAY'),
  risks LONGTEXT NOT NULL,
  next_steps LONGTEXT NOT NULL,
  model TEXT NOT NULL,
  KEY idx_expansion_owner_idea (user_id, idea_id),
  UNIQUE KEY uq_expansion_active (user_id, idea_id, (CASE WHEN deleted_at IS NULL THEN 1 ELSE NULL END)),
  FOREIGN KEY (user_id) REFERENCES `user` (id),
  FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS material (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  idea_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary LONGTEXT NOT NULL,
  source_name TEXT NOT NULL,
  published_at BIGINT NOT NULL,
  KEY idx_material_owner_idea (user_id, idea_id),
  FOREIGN KEY (user_id) REFERENCES `user` (id),
  FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `step` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  idea_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title TEXT NOT NULL,
  detail LONGTEXT NOT NULL,
  duration_min INT NOT NULL CHECK (duration_min > 0),
  sort_order INT NOT NULL,
  depends_on CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  done TINYINT NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  UNIQUE KEY uq_step_owner_id (user_id, id),
  FOREIGN KEY (user_id) REFERENCES `user` (id),
  FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id),
  FOREIGN KEY (user_id, depends_on) REFERENCES `step` (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS schedule (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idea_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  step_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title TEXT NOT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  repeat_rule TEXT NULL,
  priority TINYINT NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  done TINYINT NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  UNIQUE KEY uq_schedule_owner_id (user_id, id),
  FOREIGN KEY (user_id) REFERENCES `user` (id),
  FOREIGN KEY (user_id, idea_id) REFERENCES idea (user_id, id),
  FOREIGN KEY (user_id, step_id) REFERENCES `step` (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS reminder (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  schedule_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  remind_at BIGINT NOT NULL,
  level TINYINT NOT NULL DEFAULT 0 CHECK (level IN (0, 1)),
  sound TEXT NULL,
  snooze_min INT NOT NULL DEFAULT 10,
  enabled TINYINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  native_id TEXT NULL,
  KEY idx_reminder_owner_schedule (user_id, schedule_id),
  FOREIGN KEY (user_id) REFERENCES `user` (id),
  FOREIGN KEY (user_id, schedule_id) REFERENCES schedule (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS usage_log (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('expand','breakdown','research','asr')),
  tokens INT NOT NULL CHECK (tokens >= 0),
  KEY idx_usage_log_owner (user_id),
  FOREIGN KEY (user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
