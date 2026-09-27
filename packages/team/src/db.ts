import Database from 'better-sqlite3'
import { MIGRATIONS } from './schema.sql.ts'

export type Db = Database.Database

export interface OpenOptions {
  path: string
  readonly?: boolean
}

/** 打开团队库并跑到最新版本（幂等，与本机 store 同一套做法）。 */
export function openDb(opts: OpenOptions): Db {
  const db = new Database(opts.path, { readonly: opts.readonly ?? false })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
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
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  )
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')

  // 按版本号升序执行（书写顺序不作数，依赖只认版本号）
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue
    const run = db.transaction(() => {
      db.exec(m.sql)
      record.run(m.version, m.name, Date.now())
    })
    run()
  }
}
