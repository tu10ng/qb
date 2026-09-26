/**
 * 数据库 schema 与迁移。
 *
 * 用原生 SQL 而非 Drizzle：领域类型已经由 @qb/core 的 zod schema 定义，
 * 再引一套 ORM schema 就成了两份需要手工同步的真源。这里的读写在边界上
 * 用 zod 校验，SQL 本身保持可读。FTS5 也是原生写法最直接。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  brief_md           TEXT NOT NULL DEFAULT '',
  initiator_id       TEXT NOT NULL REFERENCES users(id),
  assignee_id        TEXT NOT NULL REFERENCES users(id),
  -- 非空 = 由某一步委派产生。递归层级靠它，不需要组织架构配置。
  parent_step_id     TEXT REFERENCES steps(id) DEFERRABLE INITIALLY DEFERRED,
  status             TEXT NOT NULL,
  expected_minutes   INTEGER,
  due_at             INTEGER,
  definition_of_done TEXT,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  ended_at           INTEGER,
  archived_at        INTEGER
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_initiator ON tasks(initiator_id, status);
CREATE INDEX idx_tasks_parent_step ON tasks(parent_step_id);

CREATE TABLE runbooks (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  version              INTEGER NOT NULL,
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           INTEGER NOT NULL,
  assumptions_json     TEXT NOT NULL DEFAULT '[]',
  source_skill_id      TEXT REFERENCES skills(id) DEFERRABLE INITIALLY DEFERRED,
  source_skill_version INTEGER,
  UNIQUE(task_id, version)
);
CREATE INDEX idx_runbooks_task ON runbooks(task_id, version DESC);

CREATE TABLE steps (
  id               TEXT PRIMARY KEY,
  runbook_id       TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES steps(id) ON DELETE CASCADE,
  -- 分数索引：拖拽重排只改被移动的一行
  order_key        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  why_md           TEXT,
  why_source       TEXT,
  command          TEXT,
  env_id           TEXT REFERENCES environments(id) DEFERRABLE INITIALLY DEFERRED,
  expectation_json TEXT,
  probe_json       TEXT,
  timeout_ms       INTEGER,
  expected_minutes REAL,
  status           TEXT NOT NULL DEFAULT 'pending',
  started_at       INTEGER,
  ended_at         INTEGER,
  actual_ms        INTEGER,
  delegate_task_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_steps_runbook ON steps(runbook_id, order_key);
CREATE INDEX idx_steps_parent ON steps(parent_id, order_key);

CREATE TABLE evidence (
  id          TEXT PRIMARY KEY,
  step_id     TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  text        TEXT,
  image_path  TEXT,
  exit_code   INTEGER,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  redacted    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_evidence_step ON evidence(step_id, created_at);

CREATE TABLE events (
  -- seq 是严格单调的插入序：同一毫秒内的多个事件靠它保持因果顺序，
  -- 将来做增量同步时也用它当游标（比时间戳可靠）。
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id      TEXT REFERENCES steps(id) ON DELETE SET NULL,
  actor_id     TEXT REFERENCES users(id),
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_events_task ON events(task_id, seq DESC);
CREATE INDEX idx_events_kind ON events(kind, seq DESC);

CREATE TABLE skills (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL DEFAULT '',
  applies_when    TEXT,
  owner_id        TEXT REFERENCES users(id),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER
);

CREATE TABLE skill_versions (
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  template_json     TEXT NOT NULL,
  stats_json        TEXT NOT NULL DEFAULT '[]',
  source_runbook_id TEXT REFERENCES runbooks(id),
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  UNIQUE(skill_id, version)
);

CREATE TABLE lessons (
  id             TEXT PRIMARY KEY,
  anchor_kind    TEXT NOT NULL,
  anchor_ref     TEXT,
  condition      TEXT,
  symptom        TEXT NOT NULL,
  cause          TEXT,
  fix_md         TEXT NOT NULL,
  next_time_md   TEXT,
  author_id      TEXT NOT NULL REFERENCES users(id),
  source_task_id TEXT REFERENCES tasks(id),
  scope          TEXT NOT NULL DEFAULT 'personal',
  confirmed_by   TEXT REFERENCES users(id),
  confirmed_at   INTEGER,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  miss_count     INTEGER NOT NULL DEFAULT 0,
  stale_at       INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_lessons_anchor ON lessons(anchor_kind, anchor_ref);
CREATE INDEX idx_lessons_scope ON lessons(scope, created_at DESC);

CREATE TABLE environments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  facts_json   TEXT NOT NULL DEFAULT '{}',
  owner_id     TEXT REFERENCES users(id),
  collected_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id      TEXT REFERENCES steps(id) ON DELETE SET NULL,
  asker_id     TEXT NOT NULL REFERENCES users(id),
  target_id    TEXT REFERENCES users(id),
  body_md      TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  answer_md    TEXT,
  answered_by  TEXT REFERENCES users(id),
  answered_at  INTEGER,
  lesson_id    TEXT REFERENCES lessons(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_questions_target ON questions(target_id, answered_at);
CREATE INDEX idx_questions_task ON questions(task_id, created_at DESC);

-- 全文检索：坑与 skill 的召回质量直接决定"下次不再踩同一个坑"。
-- 用 unicode61 并去掉 remove_diacritics（中文不需要），
-- 中文按字切分虽然粗糙，但配合前缀查询在这个规模下够用；
-- 换 embeddings 时只需改 search.ts，不动这里。
CREATE VIRTUAL TABLE lessons_fts USING fts5(
  symptom, cause, fix_md, next_time_md, condition,
  content='lessons', content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER lessons_fts_insert AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, symptom, cause, fix_md, next_time_md, condition)
  VALUES (new.rowid, new.symptom, new.cause, new.fix_md, new.next_time_md, new.condition);
END;
CREATE TRIGGER lessons_fts_delete AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, symptom, cause, fix_md, next_time_md, condition)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.fix_md, old.next_time_md, old.condition);
END;
CREATE TRIGGER lessons_fts_update AFTER UPDATE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, symptom, cause, fix_md, next_time_md, condition)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.fix_md, old.next_time_md, old.condition);
  INSERT INTO lessons_fts(rowid, symptom, cause, fix_md, next_time_md, condition)
  VALUES (new.rowid, new.symptom, new.cause, new.fix_md, new.next_time_md, new.condition);
END;

CREATE VIRTUAL TABLE skills_fts USING fts5(
  name, description, applies_when,
  content='skills', content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, applies_when)
  VALUES (new.rowid, new.name, new.description, new.applies_when);
END;
CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, applies_when)
  VALUES ('delete', old.rowid, old.name, old.description, old.applies_when);
END;
CREATE TRIGGER skills_fts_update AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, applies_when)
  VALUES ('delete', old.rowid, old.name, old.description, old.applies_when);
  INSERT INTO skills_fts(rowid, name, description, applies_when)
  VALUES (new.rowid, new.name, new.description, new.applies_when);
END;
`,
  },
]
