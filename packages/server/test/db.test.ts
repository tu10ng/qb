import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'

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
