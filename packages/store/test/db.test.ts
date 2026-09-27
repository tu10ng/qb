import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { MIGRATIONS } from '../src/schema.sql.ts'

describe('数据库 schema', () => {
  it('能建起全部表', () => {
    const db = openDb({ path: ':memory:' })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)

    for (const t of [
      'users',
      'tasks',
      'runbooks',
      'steps',
      'evidence',
      'events',
      'skills',
      'skill_versions',
      'lessons',
      'environments',
      'questions',
    ]) {
      expect(tables, `缺少表 ${t}`).toContain(t)
    }
    db.close()
  })

  it('迁移是幂等的', () => {
    const db = openDb({ path: ':memory:' })
    const before = db.prepare('SELECT count(*) c FROM schema_migrations').get() as { c: number }
    // 同一个连接再跑一次迁移不应重复应用
    const again = openDb({ path: ':memory:' })
    const after = again.prepare('SELECT count(*) c FROM schema_migrations').get() as { c: number }
    expect(after.c).toBe(before.c)
    db.close()
    again.close()
  })

  it('外键约束生效', () => {
    const db = openDb({ path: ':memory:' })
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, title, initiator_id, assignee_id, status, created_at)
           VALUES ('t1', 'x', 'nobody', 'nobody', 'draft', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('删除 runbook 级联删除 steps', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(`
      INSERT INTO users (id, name, display_name, created_at) VALUES ('u1','a','A',1);
      INSERT INTO tasks (id, title, initiator_id, assignee_id, status, created_at)
        VALUES ('t1','x','u1','u1','active',1);
      INSERT INTO runbooks (id, task_id, version, created_by, created_at)
        VALUES ('r1','t1',1,'u1',1);
      INSERT INTO steps (id, runbook_id, order_key, kind, title)
        VALUES ('s1','r1','V','command','step');
    `)
    db.prepare("DELETE FROM runbooks WHERE id='r1'").run()
    const left = db.prepare('SELECT count(*) c FROM steps').get() as { c: number }
    expect(left.c).toBe(0)
    db.close()
  })

  describe('全文检索', () => {
    it('插入坑后可被检索到', () => {
      const db = openDb({ path: ':memory:' })
      db.exec(`INSERT INTO users (id,name,display_name,created_at) VALUES ('u1','a','A',1)`)
      db.prepare(
        `INSERT INTO lessons (id, anchor_kind, symptom, fix_md, author_id, scope, created_at)
         VALUES ('l1','free','NCCL timeout during init','set NCCL_IB_DISABLE=1','u1','team',1)`,
      ).run()

      const hits = db
        .prepare(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH 'NCCL'`)
        .all()
      expect(hits).toHaveLength(1)
      db.close()
    })

    it('更新后索引同步', () => {
      const db = openDb({ path: ':memory:' })
      db.exec(`INSERT INTO users (id,name,display_name,created_at) VALUES ('u1','a','A',1)`)
      db.prepare(
        `INSERT INTO lessons (id, anchor_kind, symptom, fix_md, author_id, scope, created_at)
         VALUES ('l1','free','old symptom','fix','u1','team',1)`,
      ).run()
      db.prepare(`UPDATE lessons SET symptom='brandnew symptom' WHERE id='l1'`).run()

      expect(
        db.prepare(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH 'brandnew'`).all(),
      ).toHaveLength(1)
      expect(
        db.prepare(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH 'old'`).all(),
      ).toHaveLength(0)
      db.close()
    })

    it('删除后索引同步', () => {
      const db = openDb({ path: ':memory:' })
      db.exec(`INSERT INTO users (id,name,display_name,created_at) VALUES ('u1','a','A',1)`)
      db.prepare(
        `INSERT INTO lessons (id, anchor_kind, symptom, fix_md, author_id, scope, created_at)
         VALUES ('l1','free','doomed','fix','u1','team',1)`,
      ).run()
      db.prepare(`DELETE FROM lessons WHERE id='l1'`).run()

      expect(
        db.prepare(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH 'doomed'`).all(),
      ).toHaveLength(0)
      db.close()
    })

    it('skill 检索可用', () => {
      const db = openDb({ path: ':memory:' })
      db.prepare(
        `INSERT INTO skills (id, name, description, created_at)
         VALUES ('sk1','pd-deploy','vLLM prefill decode disaggregated deployment',1)`,
      ).run()
      expect(
        db.prepare(`SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'disaggregated'`).all(),
      ).toHaveLength(1)
      db.close()
    })
  })

  it('v1 的老库升级到最新：存量步骤补上血缘、rev 与来源，数据不丢', () => {
    // 用户本机已经有 M1–M5 时期的库，升级不能要求删库重来
    const dir = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
    const path = join(dir, 'old.db')
    try {
      const old = new Database(path)
      old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
      old.exec(MIGRATIONS[0]!.sql)
      old.prepare('INSERT INTO schema_migrations VALUES (1, ?, 1)').run(MIGRATIONS[0]!.name)
      old.exec(`
        INSERT INTO users (id, name, display_name, created_at) VALUES ('u1','a','A',1);
        INSERT INTO tasks (id, title, initiator_id, assignee_id, status, created_at)
          VALUES ('t1','x','u1','u1','active',1);
        INSERT INTO runbooks (id, task_id, version, created_by, created_at) VALUES ('r1','t1',1,'u1',1);
        INSERT INTO steps (id, runbook_id, order_key, kind, title, command)
          VALUES ('s1','r1','V','command','老步骤','nvidia-smi'), ('s2','r1','k','command','另一步','ls');
      `)
      old.close()

      const db = openDb({ path })
      const rows = db
        .prepare('SELECT id, title, command, rev, origin, lineage_key, deleted_at FROM steps ORDER BY id')
        .all() as Array<{ id: string; title: string; command: string; rev: number; origin: string; lineage_key: string | null; deleted_at: number | null }>
      expect(rows.map((r) => r.title)).toEqual(['老步骤', '另一步'])
      expect(rows[0]!.command).toBe('nvidia-smi')
      for (const r of rows) {
        expect(r.rev).toBe(0)
        expect(r.origin).toBe('qb')
        expect(r.deleted_at).toBeNull()
        expect(r.lineage_key).toMatch(/^lin_[0-9a-f]{16}$/)
      }
      // 每一步的血缘各不相同
      expect(new Set(rows.map((r) => r.lineage_key)).size).toBe(2)
      db.close()

      // v1 库带假设的 runbook：一路升到最新后，假设变成"QB 猜的"展示参数
      const dir2 = mkdtempSync(join(tmpdir(), 'qb-migrate1-'))
      const path2 = join(dir2, 'old.db')
      try {
        const old1 = new Database(path2)
        old1.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
        old1.exec(MIGRATIONS[0]!.sql)
        old1.prepare('INSERT INTO schema_migrations VALUES (1, ?, 1)').run(MIGRATIONS[0]!.name)
        old1.exec(`
          INSERT INTO users (id, name, display_name, created_at) VALUES ('u1','a','A',1);
          INSERT INTO tasks (id, title, initiator_id, assignee_id, status, created_at)
            VALUES ('t1','升级 vLLM','u1','u1','done',1);
          INSERT INTO runbooks (id, task_id, version, created_by, created_at, assumptions_json)
            VALUES ('r1','t1',1,'u1',1,'[{"key":"版本","value":"0.11.0","editedByUser":false}]');
        `)
        old1.close()

        const db1 = openDb({ path: path2 })
        const row = db1.prepare('SELECT params_json FROM runbooks WHERE id = ?').get('r1') as { params_json: string }
        expect(JSON.parse(row.params_json)).toEqual([{ name: '版本', value: '0.11.0', source: 'qb_guess', secret: 0 }])
        // v1→最新一路也回填了任务索引
        expect(db1.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'vllm'`).all()).toHaveLength(1)
        db1.close()
      } finally {
        try {
          rmSync(dir2, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          /* 留给系统清理 */
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('v2 的库升级到 v3：假设迁成参数，素材表与任务索引可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qb-migrate3-'))
    const path = join(dir, 'old.db')
    try {
      // 手工造一个 v2 库（只应用前两个迁移）
      const old = new Database(path)
      old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
      for (const m of MIGRATIONS.slice(0, 2)) {
        old.exec(m.sql)
        old.prepare('INSERT INTO schema_migrations VALUES (?, ?, 1)').run(m.version, m.name)
      }
      old.exec(`
        INSERT INTO users (id, name, display_name, created_at) VALUES ('u1','a','A',1);
        INSERT INTO tasks (id, title, brief_md, initiator_id, assignee_id, status, created_at)
          VALUES ('t1','在 X 集群部署 vLLM PD 分离','','u1','u1','done',1);
        INSERT INTO runbooks (id, task_id, version, created_by, created_at, assumptions_json)
          VALUES ('r1','t1',1,'u1',1,
                  '[{"key":"集群","value":"X","editedByUser":false},{"key":"模型","value":"Qwen2.5-72B","editedByUser":false}]');
      `)
      old.close()

      const db = openDb({ path })
      // 假设 → 参数（qb_guess），数据不丢
      const params = db.prepare('SELECT params_json FROM runbooks WHERE id = ?').get('r1') as { params_json: string }
      const parsed = JSON.parse(params.params_json) as Array<{ name: string; value: string; source: string }>
      expect(parsed).toEqual([
        { name: '集群', value: 'X', source: 'qb_guess', secret: 0 },
        { name: '模型', value: 'Qwen2.5-72B', source: 'qb_guess', secret: 0 },
      ])
      // 任务索引建好了且同步
      expect(db.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'vllm'`).all()).toHaveLength(1)
      db.close()
    } finally {
      // Windows 上偶发句柄释放延迟（EPERM）；临时目录留给 OS 清理即可，
      // 清不掉不算测试失败
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        /* 留给系统清理 */
      }
    }
  })

  it('v7 的库升级到 v8：存量中文任务与坑补上切分，能被中文检索到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qb-migrate8-'))
    const path = join(dir, 'old.db')
    try {
      // 手工造一个 v7 库：按版本号应用前 7 个迁移
      const old = new Database(path)
      old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
      for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => m.version <= 7)) {
        old.exec(m.sql)
        old.prepare('INSERT INTO schema_migrations VALUES (?, ?, 1)').run(m.version, m.name)
      }
      old.exec(`
        INSERT INTO users (id, name, display_name, created_at) VALUES ('u1','a','A',1);
        INSERT INTO tasks (id, title, brief_md, initiator_id, assignee_id, status, created_at)
          VALUES ('t1','升级驱动到 550','','u1','u1','done',1);
        INSERT INTO lessons (id, anchor_kind, symptom, fix_md, author_id, scope, created_at)
          VALUES ('l1','free','初始化卡住','统一驱动','u1','personal',1);
      `)
      // 旧索引下纯中文单字查询确实查不到（这就是 bug）
      expect(old.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '"升级"'`).all()).toHaveLength(0)
      old.close()

      const db = openDb({ path })
      expect(db.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '"升级"'`).all()).toHaveLength(1)
      expect(db.prepare(`SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH '"卡住"'`).all()).toHaveLength(1)
      // 状态更新不再触发重建索引，也不破坏索引
      db.prepare(`UPDATE tasks SET status = 'active' WHERE id = 't1'`).run()
      expect(db.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '"驱动"'`).all()).toHaveLength(1)
      db.close()
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        /* 留给系统清理 */
      }
    }
  })

  it('任务可以指向父步骤（递归委派）', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(`
      INSERT INTO users (id,name,display_name,created_at) VALUES ('u1','a','A',1),('u2','b','B',1);
      INSERT INTO tasks (id,title,initiator_id,assignee_id,status,created_at)
        VALUES ('t1','parent','u1','u1','active',1);
      INSERT INTO runbooks (id,task_id,version,created_by,created_at) VALUES ('r1','t1',1,'u1',1);
      INSERT INTO steps (id,runbook_id,order_key,kind,title) VALUES ('s1','r1','V','delegate','派活');
      INSERT INTO tasks (id,title,initiator_id,assignee_id,parent_step_id,status,created_at)
        VALUES ('t2','child','u1','u2','s1','draft',1);
      UPDATE steps SET delegate_task_id='t2' WHERE id='s1';
    `)
    const child = db.prepare("SELECT parent_step_id p FROM tasks WHERE id='t2'").get() as {
      p: string
    }
    expect(child.p).toBe('s1')
    db.close()
  })
})
