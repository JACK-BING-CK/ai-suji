CREATE TABLE IF NOT EXISTS sync_publications (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_name VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, table_name, record_id),
  KEY idx_sync_publications_cursor (user_id, published_at),
  FOREIGN KEY (user_id) REFERENCES `user` (id)
) ENGINE=InnoDB;

INSERT IGNORE INTO sync_publications (user_id, table_name, record_id, published_at)
  SELECT user_id, 'idea', id, GREATEST(updated_at, 1) FROM idea UNION ALL
  SELECT user_id, 'expansion', id, GREATEST(updated_at, 1) FROM expansion UNION ALL
  SELECT user_id, 'material', id, GREATEST(updated_at, 1) FROM material UNION ALL
  SELECT user_id, 'step', id, GREATEST(updated_at, 1) FROM `step` UNION ALL
  SELECT user_id, 'schedule', id, GREATEST(updated_at, 1) FROM schedule UNION ALL
  SELECT user_id, 'reminder', id, GREATEST(updated_at, 1) FROM reminder;
