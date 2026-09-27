/**
 * pnpm e2e：把全部端到端场景依次真跑一遍（功能真相表的证据）。
 *
 * UI 先构建到临时目录（不动 packages/ui/dist——开着的开发实例在用它），
 * 已设 QB_E2E_UI_DIR 时直接用。任何一个场景失败，整体退出码非 0。
 *
 * 用法：pnpm e2e          全部
 *       pnpm e2e phase0   只跑某几个（phase0 / m8 / m9 / ui-check）
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './lib.mjs'

const ALL = ['phase0', 'm8', 'm9', 'ui-check']
const pick = process.argv.slice(2)
const scenarios = pick.length > 0 ? ALL.filter((s) => pick.includes(s)) : ALL

let uiDir = process.env.QB_E2E_UI_DIR
if (uiDir === undefined) {
  uiDir = join(mkdtempSync(join(tmpdir(), 'qb-e2e-ui-')), 'dist')
  console.log(`构建界面到 ${uiDir}`)
  const build = spawnSync('pnpm', ['--filter', '@qb/ui', 'exec', 'vite', 'build', '--outDir', uiDir, '--emptyOutDir'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const summary = []
for (const s of scenarios) {
  console.log(`\n══ ${s} ══`)
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts/e2e', `${s}.mjs`)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, QB_E2E_UI_DIR: uiDir },
  })
  summary.push([s, r.status === 0])
}

console.log('\n══ 汇总 ══')
for (const [s, ok] of summary) console.log(`${ok ? '✓' : '✗'} ${s}`)
process.exit(summary.every(([, ok]) => ok) ? 0 : 1)
