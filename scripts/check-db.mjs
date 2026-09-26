/** 直接读库检查数据是否干净，绕开控制台编码干扰。 */
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
const Database = require_(
  require_.resolve('better-sqlite3', { paths: [new URL('../packages/server', import.meta.url).pathname.slice(1)] }),
)
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const db = new Database(join(repoRoot, '.run/qb.db'), { readonly: true })

const hasLone = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

let dirty = 0
for (const table of ['events', 'evidence', 'steps', 'tasks']) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all()
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && hasLone(v)) {
        dirty++
        console.log(`✗ ${table}.${k}: ${JSON.stringify(v).slice(0, 120)}`)
      }
    }
  }
}

// 单独看一下最后一条事件的 reason，确认它的真实内容
const last = db.prepare('SELECT payload_json FROM events ORDER BY seq DESC LIMIT 1').get()
if (last) {
  const p = JSON.parse(last.payload_json)
  console.log('\n最后一条事件 reason:', JSON.stringify(p.reason ?? null))
}

// 环境事实：起草质量直接取决于这些
const envs = db.prepare('SELECT name, facts_json FROM environments').all()
if (envs.length > 0) {
  console.log('\n采集到的环境：')
  for (const e of envs) {
    console.log(` ${e.name}: ${JSON.stringify(JSON.parse(e.facts_json), null, 1).replace(/\n/g, '\n ')}`)
  }
}

console.log(dirty === 0 ? '\n✓ 数据库中没有非法代理项' : `\n✗ 发现 ${dirty} 处污染`)
db.close()
process.exit(dirty === 0 ? 0 : 1)
