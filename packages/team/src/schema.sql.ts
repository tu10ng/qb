/**
 * 团队服务的库表（自管 schema，与本机 store 无关）。
 *
 * 真源在本机引擎：这里存的是任务/runbook/事件的**镜像**，加上只有团队
 * 服务才有的东西（用户与令牌、告警、评论、求助、推送渠道）。
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
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  -- 首位注册用户即管理员：推送渠道（命令渠道=shell）与邀请只有他能配
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 令牌只存哈希。执行引擎与浏览器用同一个发法：邀请链接进来的个人令牌。
CREATE TABLE tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE invites (
  token      TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 任务镜像（引擎是唯一写者；这里只接收快照）
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  brief_md         TEXT NOT NULL DEFAULT '',
  initiator_name   TEXT NOT NULL DEFAULT '',
  assignee_name    TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL,
  expected_minutes INTEGER,
  started_at       INTEGER,
  ended_at         INTEGER,
  runbook_version  INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE steps (
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  parent_id        TEXT,
  order_key        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  command          TEXT,
  status           TEXT NOT NULL,
  expected_minutes REAL,
  actual_ms        INTEGER,
  status_note      TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (task_id, id)
);
CREATE INDEX idx_steps_task ON steps(task_id, parent_id, order_key);

-- 事件镜像。engine_seq 是引擎本地事件的 seq，带唯一约束做推送重试的幂等。
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  engine_seq  INTEGER NOT NULL,
  step_id     TEXT,
  actor_name  TEXT,
  kind        TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  UNIQUE(task_id, engine_seq)
);
CREATE INDEX idx_events_task ON events(task_id, seq DESC);

-- 告警：key 来自引擎的确定性规则；open → ack（发起人知道了）→ resolved
CREATE TABLE alerts (
  key         TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id     TEXT,
  level       TEXT NOT NULL,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'open',
  acked_by    TEXT REFERENCES users(id),
  acked_at    INTEGER,
  down_seq    INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_alerts_task ON alerts(task_id, status);

-- 评论（含"建议修改"：kind=comment，正文里写命令块，执行者复制进差异流程）
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id     TEXT,
  author_id   TEXT REFERENCES users(id),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  down_seq    INTEGER NOT NULL
);
CREATE INDEX idx_comments_task ON comments(task_id, created_at);
CREATE INDEX idx_comments_down ON comments(down_seq);

-- 求助：引擎代拟发出；发起人回答；回答要回流到执行者的那一步上
CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id         TEXT,
  asker_name      TEXT NOT NULL,
  body            TEXT NOT NULL,
  answer          TEXT,
  answered_by_name TEXT,
  answered_at     INTEGER,
  created_at      INTEGER NOT NULL,
  down_seq        INTEGER NOT NULL
);
CREATE INDEX idx_questions_task ON questions(task_id, created_at);
CREATE INDEX idx_questions_down ON questions(down_seq);

-- 推送渠道：webhook（POST JSON）或 command（外部命令，如 python 脚本，
-- JSON 走 stdin，纯文本走环境变量 QB_ALERT_TEXT）
CREATE TABLE push_channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  min_level   TEXT NOT NULL DEFAULT 'red',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE down_seq (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  seq   INTEGER NOT NULL
);
INSERT INTO down_seq (id, seq) VALUES (1, 0);
`,
  },
  {
    version: 2,
    name: 'dispatch-and-delegation',
    sql: `
-- 远程派的任务：PL（或委派者）在远程 UI 创建，排队等目标执行者的引擎
-- 拉走。引擎落地后按正常镜像回传，发起人那边就能看到它。
CREATE TABLE dispatched_tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  brief_md          TEXT NOT NULL DEFAULT '',
  initiator_name    TEXT NOT NULL,
  assignee_name     TEXT NOT NULL,
  parent_step_id    TEXT,
  expected_minutes  INTEGER,
  definition_of_done TEXT,
  created_at        INTEGER NOT NULL,
  down_seq          INTEGER NOT NULL
);
CREATE INDEX idx_dispatched_down ON dispatched_tasks(assignee_name, down_seq);

-- 委派行需要：父步骤 → 子任务的映射（镜像里带过来）
ALTER TABLE tasks ADD COLUMN parent_step_id TEXT;

-- 委派进度：子任务快照更新时给父任务执行者一条下行
CREATE TABLE task_progress (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  parent_step_id TEXT NOT NULL,
  assignee_name  TEXT NOT NULL,
  status         TEXT NOT NULL,
  done           INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  down_seq       INTEGER NOT NULL
);
CREATE INDEX idx_task_progress_down ON task_progress(assignee_name, down_seq);
`,
  },
]
