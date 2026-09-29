/**
 * 数据库 schema 与迁移。
 *
 * 用原生 SQL 而非 Drizzle：领域类型已经由 @qb/core 的 zod schema 定义，
 * 再引一套 ORM schema 就成了两份需要手工同步的真源。这里的读写在边界上
 * 用 zod 校验，SQL 本身保持可读。FTS5 也是原生写法最直接。
 */

import type { Db } from './db.ts'
import { cjkIndexText } from './fts.ts'

export interface Migration {
  version: number
  name: string
  sql: string
  /** sql 之后、同一事务里跑的数据迁移（SQL 算不了的派生值，如中文切分）。 */
  apply?: (db: Db) => void
}

/**
 * 三张全文索引表的定义（v8 起）。外部内容表：原文列 + fts_cjk（汉字的
 * 单字与二元组，见 fts.ts）。触发器只在文本列变化时重建索引——状态、
 * 计数这类更新不再白白删了又插。
 */
const FTS_SQL = `
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, brief_md, fts_cjk,
  content='tasks', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, brief_md, fts_cjk)
  VALUES (new.rowid, new.title, new.brief_md, new.fts_cjk);
END;
CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, brief_md, fts_cjk)
  VALUES ('delete', old.rowid, old.title, old.brief_md, old.fts_cjk);
END;
CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, brief_md, fts_cjk ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, brief_md, fts_cjk)
  VALUES ('delete', old.rowid, old.title, old.brief_md, old.fts_cjk);
  INSERT INTO tasks_fts(rowid, title, brief_md, fts_cjk)
  VALUES (new.rowid, new.title, new.brief_md, new.fts_cjk);
END;
INSERT INTO tasks_fts(rowid, title, brief_md, fts_cjk) SELECT rowid, title, brief_md, fts_cjk FROM tasks;

CREATE VIRTUAL TABLE lessons_fts USING fts5(
  symptom, cause, fix_md, next_time_md, condition, fts_cjk,
  content='lessons', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER lessons_fts_insert AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk)
  VALUES (new.rowid, new.symptom, new.cause, new.fix_md, new.next_time_md, new.condition, new.fts_cjk);
END;
CREATE TRIGGER lessons_fts_delete AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.fix_md, old.next_time_md, old.condition, old.fts_cjk);
END;
CREATE TRIGGER lessons_fts_update AFTER UPDATE OF symptom, cause, fix_md, next_time_md, condition, fts_cjk ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.fix_md, old.next_time_md, old.condition, old.fts_cjk);
  INSERT INTO lessons_fts(rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk)
  VALUES (new.rowid, new.symptom, new.cause, new.fix_md, new.next_time_md, new.condition, new.fts_cjk);
END;
INSERT INTO lessons_fts(rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk)
  SELECT rowid, symptom, cause, fix_md, next_time_md, condition, fts_cjk FROM lessons;

CREATE VIRTUAL TABLE skills_fts USING fts5(
  name, description, applies_when, fts_cjk,
  content='skills', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, applies_when, fts_cjk)
  VALUES (new.rowid, new.name, new.description, new.applies_when, new.fts_cjk);
END;
CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, applies_when, fts_cjk)
  VALUES ('delete', old.rowid, old.name, old.description, old.applies_when, old.fts_cjk);
END;
CREATE TRIGGER skills_fts_update AFTER UPDATE OF name, description, applies_when, fts_cjk ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, applies_when, fts_cjk)
  VALUES ('delete', old.rowid, old.name, old.description, old.applies_when, old.fts_cjk);
  INSERT INTO skills_fts(rowid, name, description, applies_when, fts_cjk)
  VALUES (new.rowid, new.name, new.description, new.applies_when, new.fts_cjk);
END;
INSERT INTO skills_fts(rowid, name, description, applies_when, fts_cjk)
  SELECT rowid, name, description, applies_when, fts_cjk FROM skills;
`

/** v8 的数据部分：给存量行补上汉字切分，再重建三张索引表。 */
function backfillCjkAndRebuildFts(db: Db): void {
  const tasks = db.prepare('SELECT rowid, title, brief_md FROM tasks').all() as Array<{ rowid: number; title: string; brief_md: string }>
  const setTask = db.prepare('UPDATE tasks SET fts_cjk = ? WHERE rowid = ?')
  for (const t of tasks) setTask.run(cjkIndexText(t.title, t.brief_md), t.rowid)

  const lessons = db
    .prepare('SELECT rowid, symptom, cause, fix_md, next_time_md, condition FROM lessons')
    .all() as Array<{ rowid: number; symptom: string; cause: string | null; fix_md: string; next_time_md: string | null; condition: string | null }>
  const setLesson = db.prepare('UPDATE lessons SET fts_cjk = ? WHERE rowid = ?')
  for (const l of lessons) setLesson.run(cjkIndexText(l.symptom, l.cause, l.fix_md, l.next_time_md, l.condition), l.rowid)

  const skills = db.prepare('SELECT rowid, name, description, applies_when FROM skills').all() as Array<{ rowid: number; name: string; description: string; applies_when: string | null }>
  const setSkill = db.prepare('UPDATE skills SET fts_cjk = ? WHERE rowid = ?')
  for (const s of skills) setSkill.run(cjkIndexText(s.name, s.description, s.applies_when), s.rowid)

  db.exec(FTS_SQL)
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
  {
    version: 6,
    name: 'share-output-and-alert-snooze',
    sql: `
-- 步骤级"共享输出"开关：默认关（隐私优先）；打开后该步的最新输出
-- （脱敏 + 截尾）随快照同步到团队服务，发起人远程 UI 能看到
ALTER TABLE steps ADD COLUMN share_output INTEGER NOT NULL DEFAULT 0;

-- 告警静音：执行者"我能搞定"，30 分钟内不出声
CREATE TABLE alert_snooze (
  key        TEXT NOT NULL,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  snoozed_by TEXT REFERENCES users(id),
  until      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, task_id)
);
`,
  },
  {
    version: 4,
    name: 'runbook-material-link',
    sql: `
-- 这份 runbook 是从哪份素材整理来的。保真报告必须对着导入时的那份
-- 素材比——之后任务里又贴了新素材的话，latestMaterial 会指错。
ALTER TABLE runbooks ADD COLUMN material_id TEXT REFERENCES materials(id) ON DELETE SET NULL;
`,
  },
  {
    version: 5,
    name: 'team-sync',
    sql: `
-- M8：求助是否已推给团队服务（0=待推，1=已推）
ALTER TABLE questions ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0;

-- 同步游标（已推到哪条事件、下行拉到哪号）等小状态
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 7,
    name: 'lesson-lineage-and-offers',
    sql: `
-- M9：坑锚定到步骤血缘（anchor_kind='step_lineage'，anchor_ref=lineage_key），
-- 同血缘的所有 runbook 复制品都看得见。远程下发的坑带作者名；
-- uploaded=1 表示已上传团队服务（远程下发的也置 1，防止回环再传）。
ALTER TABLE lessons ADD COLUMN author_name TEXT;
ALTER TABLE lessons ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0;

-- 捕获提议：QB 觉得"这里可能有个坑/改动该带回底稿"，等人确认。
-- kind: fix=失败后修好 / question=求助回答待沉淀 / deviation=偏离底稿 /
--       proposal=别人带回底稿的提议 / situation=情况变了的原因
CREATE TABLE lesson_offers (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id     TEXT REFERENCES steps(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- 同类提议的去重键（如 questionId / lineageKey），pending 状态下不重发
  dedup_key   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_lesson_offers_task ON lesson_offers(task_id, status, created_at);
CREATE UNIQUE INDEX idx_lesson_offers_dedup ON lesson_offers(task_id, kind, dedup_key, status)
  WHERE dedup_key IS NOT NULL AND status = 'pending';
`,
  },
  {
    version: 8,
    name: 'fts-cjk',
    sql: `
-- 中文检索修复：unicode61 把连续汉字存成一个词元，单字/二元组都查不到。
-- 加 fts_cjk 列存汉字的单字与二元组（fts.ts 计算），索引表重建。
DROP TRIGGER IF EXISTS tasks_fts_insert;
DROP TRIGGER IF EXISTS tasks_fts_delete;
DROP TRIGGER IF EXISTS tasks_fts_update;
DROP TRIGGER IF EXISTS lessons_fts_insert;
DROP TRIGGER IF EXISTS lessons_fts_delete;
DROP TRIGGER IF EXISTS lessons_fts_update;
DROP TRIGGER IF EXISTS skills_fts_insert;
DROP TRIGGER IF EXISTS skills_fts_delete;
DROP TRIGGER IF EXISTS skills_fts_update;
DROP TABLE IF EXISTS tasks_fts;
DROP TABLE IF EXISTS lessons_fts;
DROP TABLE IF EXISTS skills_fts;
ALTER TABLE tasks ADD COLUMN fts_cjk TEXT NOT NULL DEFAULT '';
ALTER TABLE lessons ADD COLUMN fts_cjk TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN fts_cjk TEXT NOT NULL DEFAULT '';
`,
    apply: backfillCjkAndRebuildFts,
  },
  {
    version: 9,
    name: 'delegations',
    sql: `
-- 委派：我这一步交给了谁、对方任务在团队服务上的 id、对方进度。
-- 委派方本机不再建子任务副本（那份副本会被当成另一个任务推上去，
-- 成了团队里的幽灵任务）；对方的任务只在对方引擎上，这里只记关联与进度。
CREATE TABLE delegations (
  step_id       TEXT PRIMARY KEY REFERENCES steps(id) ON DELETE CASCADE,
  team_task_id  TEXT NOT NULL,
  assignee_name TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  done          INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  worst_alert   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_delegations_team_task ON delegations(team_task_id);
`,
  },
  {
    version: 10,
    name: 'remote-parent-step',
    sql: `
-- 别人委派给我的任务：父步骤在委派方的机器上，本机 steps 表里没有。
-- parent_step_id 带外键（本机委派用），跨机器的父步骤存这里——原先硬塞进
-- parent_step_id，提交时外键失败，整批下行回滚，这台引擎从此同步不了。
ALTER TABLE tasks ADD COLUMN parent_step_ref TEXT;
`,
  },
  {
    version: 11,
    name: 'manual-blocks-and-doc-lineage',
    sql: `
-- runbook 是可以执行的手册：块有章节（任意层）、文字、代码、回显。
-- 原来"顶层的 note"就是章节，改成显式的 section；嵌套的 note 本来就是说明，
-- 把标题当正文。
UPDATE steps SET kind = 'section' WHERE kind = 'note' AND parent_id IS NULL;
ALTER TABLE steps ADD COLUMN body_md TEXT;
ALTER TABLE steps ADD COLUMN lang TEXT;
-- 参考回显：跑完应该看到什么（随文档复制，版本之间可以对比）
ALTER TABLE steps ADD COLUMN ref_md TEXT;
-- 标题是按内容自动取的（导入/粘贴来的块）：界面不单独显示，内容改了跟着变
ALTER TABLE steps ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;
-- 嵌套的说明：原来只有标题（和"为什么"），合起来当正文
UPDATE steps SET body_md = title || CASE WHEN why_md IS NOT NULL AND why_md != '' THEN char(10) || char(10) || why_md ELSE '' END,
                 title_auto = 1
  WHERE kind = 'note';
-- 文档血缘：同一任务的各版本、以它为底稿复制出来的 runbook 共用；挂在
-- 整份文档上的问答锚在它上面
ALTER TABLE runbooks ADD COLUMN lineage_key TEXT;
-- 直接写表达式（不包子查询）：不相关的标量子查询 SQLite 只算一次，所有行会拿到同一个值
UPDATE runbooks SET lineage_key = 'doc_' || lower(hex(randomblob(8))) WHERE lineage_key IS NULL;
-- 同一任务的各版本共用第一个版本的血缘
UPDATE runbooks SET lineage_key = (
  SELECT r0.lineage_key FROM runbooks r0 WHERE r0.task_id = runbooks.task_id ORDER BY r0.version LIMIT 1
);
CREATE INDEX idx_runbooks_lineage ON runbooks(lineage_key);
`,
  },
]
