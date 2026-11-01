-- Only the Worker binding may access this database. Read IDs convey viewing;
-- SHA-256 hashes authenticate the separate deletion capabilities.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144),
  delete_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE share_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes >= 0),
  max_bytes INTEGER NOT NULL DEFAULT 100000000,
  day TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0,
  max_daily INTEGER NOT NULL DEFAULT 1000
);
INSERT INTO share_budget(id) VALUES (1);
-- Admission and accounting are part of the INSERT transaction. Concurrent
-- publishers cannot overshoot the budget; deletion never refunds daily writes.
CREATE TRIGGER shares_admit BEFORE INSERT ON shares BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM share_budget WHERE id = 1
      AND used_bytes + NEW.bytes <= max_bytes
      AND (CASE WHEN day = date('now') THEN published ELSE 0 END) < max_daily
  ) THEN RAISE(ABORT, 'share_capacity') END;
END;
CREATE TRIGGER shares_account AFTER INSERT ON shares BEGIN
  UPDATE share_budget SET used_bytes = used_bytes + NEW.bytes,
    published = (CASE WHEN day = date('now') THEN published ELSE 0 END) + 1,
    day = date('now') WHERE id = 1;
END;
CREATE TRIGGER shares_release AFTER DELETE ON shares BEGIN
  UPDATE share_budget SET used_bytes = used_bytes - OLD.bytes WHERE id = 1;
END;
