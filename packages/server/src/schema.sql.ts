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
  {
    version: 2,
    name: 'editable-runbook-and-model-profiles',
    sql: `
-- runbook 改为原地修改：每次编辑是一条 edit 事件，不再新建版本。
-- rev 做乐观并发；deleted_at 让删除可撤销。
ALTER TABLE steps ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
-- 步骤血缘：复制底稿时保留，坑挂在它上面。存量步骤各补一个。
ALTER TABLE steps ADD COLUMN lineage_key TEXT;
-- 存量步骤都是起草或接口写入的，按 QB 写的算。
ALTER TABLE steps ADD COLUMN origin TEXT NOT NULL DEFAULT 'qb';
ALTER TABLE steps ADD COLUMN edited_by TEXT REFERENCES users(id);
ALTER TABLE steps ADD COLUMN source_ref TEXT;
ALTER TABLE steps ADD COLUMN deleted_at INTEGER;
ALTER TABLE steps ADD COLUMN status_note TEXT;
UPDATE steps SET lineage_key = 'lin_' || lower(hex(randomblob(8))) WHERE lineage_key IS NULL;
CREATE INDEX idx_steps_lineage ON steps(lineage_key);

-- QB 的大改（导入、调整、重规划）原地应用之前先留一份快照，供对比与回退。
CREATE TABLE runbook_snapshots (
  id          TEXT PRIMARY KEY,
  runbook_id  TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  steps_json  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_runbook ON runbook_snapshots(runbook_id, created_at DESC);

-- 模型档案。key 只存本机这份库里，永不同步、不写日志。
CREATE TABLE model_profiles (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  preset            TEXT NOT NULL,
  wire              TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  api_key           TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL,
  options_json      TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 本机设置（按用途选哪个模型档案等）。
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'params-materials-and-bases',
    sql: `
-- 参数表（M7）。命令模板里的 {{NAME}} 在这里取值；复制和运行用渲染后的命令。
ALTER TABLE runbooks ADD COLUMN params_json TEXT;
-- 模式 A 的"底稿"：这份 runbook 从哪份复制/差异而来。
ALTER TABLE runbooks ADD COLUMN base_runbook_id TEXT REFERENCES runbooks(id) DEFERRABLE INITIALLY DEFERRED;
-- 这份 runbook 怎么来的。
ALTER TABLE runbooks ADD COLUMN origin TEXT;

-- 存量假设迁成"QB 猜的"展示参数：界面从假设面板换成参数面板时数据不断档。
-- 名字保持原文（如中文维度名），模板渲染只认大写下划线，互不干扰。
-- 注意 json_each 展开数组时 key 是下标，真正的字段要用 json_extract 取。
UPDATE runbooks SET params_json = (
  SELECT json_group_array(
           json_object('name', json_extract(je.value, '$.key'),
                       'value', json_extract(je.value, '$.value'),
                       'source', 'qb_guess', 'secret', 0))
  FROM json_each(runbooks.assumptions_json) je
) WHERE assumptions_json IS NOT NULL AND assumptions_json != '[]';

-- 用户贴进来的素材（文档/脚本/聊天/终端日志），保真与覆盖检查、出处引用都对着它。
CREATE TABLE materials (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  filename    TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_materials_task ON materials(task_id, created_at DESC);

-- 找底稿用的任务全文索引（标题 + 描述）。
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, brief_md,
  content='tasks', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, brief_md)
  VALUES (new.rowid, new.title, new.brief_md);
END;
CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, brief_md)
  VALUES ('delete', old.rowid, old.title, old.brief_md);
END;
CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, brief_md)
  VALUES ('delete', old.rowid, old.title, old.brief_md);
  INSERT INTO tasks_fts(rowid, title, brief_md)
  VALUES (new.rowid, new.title, new.brief_md);
END;

-- 存量任务回填（建表时触发器还没生效，不回填就永远搜不到老任务）
INSERT INTO tasks_fts(rowid, title, brief_md) SELECT rowid, title, brief_md FROM tasks;
`,
  },
]
