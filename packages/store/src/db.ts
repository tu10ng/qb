import Database from 'better-sqlite3'
import { MIGRATIONS } from './schema.sql.ts'

export type Db = Database.Database

export interface OpenOptions {
  /** ':memory:' 用于测试。 */
  path: string
  readonly?: boolean
}

/**
 * 打开数据库并跑到最新版本。
 *
 * 迁移是幂等的：已应用的版本记录在 schema_migrations 里。
 */
export function openDb(opts: OpenOptions): Db {
  const db = new Database(opts.path, { readonly: opts.readonly ?? false })

  // WAL 让读写不互相阻塞——engine 写证据的同时 UI 在轮询任务列表。
  db.pragma('journal_mode = WAL')
  // 外键约束默认是关的，不开的话 REFERENCES 只是注释。
  db.pragma('foreign_keys = ON')
  // 崩溃时最多丢最后一个事务，换来显著的写入速度。本地单机工具可接受。
  db.pragma('synchronous = NORMAL')

  migrate(db)
  return db
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  )

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )

  // 按版本号升序执行：MIGRATIONS 数组里的书写顺序不作数（历史原因 v6
  // 写在了 v4 前面），依赖关系只认版本号
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue

    // 每个迁移单独一个事务：失败时不会留下半个 schema。
    const run = db.transaction(() => {
      db.exec(m.sql)
      m.apply?.(db)
      record.run(m.version, m.name, Date.now())
    })
    run()
  }
}
