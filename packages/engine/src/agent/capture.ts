/**
 * 捕获时机（M9，方案 §6.1）——全是确定性检测，不叫模型：
 *
 * 1. 失败后修好：同一步 failed → 改了命令 → 跑通。症状=失败输出的尾部，
 *    修法=改前→改后的 diff，条件=修好命令里用到的参数（预填可改）。
 * 3. 偏离底稿：底稿复制来的步骤命令改了，与底稿同血缘步骤对比，
 *    问"要把这个改动带回底稿吗"。
 * 4. 情况变了：应用差异时写的 reason（api-m7 里直接建提议）。
 * 5. 求助回答：发起人回答到达（sync.ts 里建提议）。
 *
 * 2（每步 [记个坑] 按钮）、6（导入的坑锚血缘）、7（复盘清单）分别在
 * api-m9 / api-m7 / 复盘接口里。提议落 lesson_offers，人确认才成坑。
 */

import { conditionFromParams, PARAM_RE, redact } from '@qb/core'
import type { Store } from '@qb/store'

/** 症状展示上限：报错在尾部，截前面。 */
const SYMPTOM_MAX = 300

/**
 * 某步刚跑通时看一眼：之前失败过、且失败之后命令被改过 → 提议记坑。
 * 事件窗口 60 条足够覆盖"失败几次、改几次"的折腾。
 */
export function detectFixOffer(store: Store, taskId: string, stepId: string): void {
  const step = store.getStep(stepId)
  if (step === null || step.command === null) return

  const events = store.listEvents(taskId, 60).filter((e) => e.stepId === stepId)
  // 最近一条失败 + 之后有过命令编辑，才谈得上"失败后修好"
  let lastFailIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'step_failed' || events[i]!.kind === 'step_timeout') {
      lastFailIdx = i
      break
    }
  }
  if (lastFailIdx === -1) return
  const afterFail = events.slice(lastFailIdx + 1)
  const edits = afterFail.filter((e) => {
    if (e.kind !== 'edit') return false
    const changes = Array.isArray(e.payload.changes) ? (e.payload.changes as Array<{ field: string }>) : []
    return changes.some((c) => c.field === 'command')
  })
  if (edits.length === 0) return

  // 修法 = 最后一次命令编辑的改前→改后
  const lastEdit = edits[edits.length - 1]!
  const changes = lastEdit.payload.changes as Array<{ field: string; before: unknown; after: unknown }>
  const cmdChange = changes.find((c) => c.field === 'command')!
  const before = String(cmdChange.before ?? '')
  const after = String(cmdChange.after ?? '')
  if (before === after) return

  // 症状 = 失败那次运行的输出尾部（本次跑通开始前的最后一条证据）
  const runbook = store.getLatestRunbook(taskId)
  const startedAt = step.startedAt ?? Date.now()
  const failing = store
    .listEvidence(stepId)
    .filter((e) => e.createdAt <= startedAt && e.imagePath === null && e.text !== null)
    .at(-1)
  const symptom = failing?.text != null ? tailLines(failing.text) : '（失败输出没有留痕）'
  // 同症状已记过坑就不再问
  if (store.hasLesson(taskId, symptom)) return

  // 条件预填：修好的命令里用到的、有值的参数
  const names = [...new Set([...after.matchAll(PARAM_RE)].map((m) => m[1]!))]
  const conditionHint = runbook !== null ? conditionFromParams(runbook.runbook.params, names) : null

  store.createLessonOffer({
    taskId,
    stepId,
    kind: 'fix',
    dedupKey: `fix:${stepId}:r${step.rev}`,
    payload: { symptom, before, after, condition: conditionHint },
  })
}

/** 命令编辑后看一眼：复制自底稿的步骤偏离了底稿 → 提议带回。 */
export function detectDeviationOffer(store: Store, taskId: string, stepId: string, before: string, after: string): void {
  if (before === after) return
  const step = store.getStep(stepId)
  if (step === null || step.origin !== 'base' || step.lineageKey === null) return
  const latest = store.getLatestRunbook(taskId)
  if (latest === null || latest.runbook.baseRunbookId === null) return

  // 与底稿同血缘步骤比：当前命令和底稿不一样才叫偏离
  const baseStep = store.stepByLineage(latest.runbook.baseRunbookId, step.lineageKey)
  if (baseStep === null || baseStep.command === null || baseStep.command === step.command) return

  store.createLessonOffer({
    taskId,
    stepId,
    kind: 'deviation',
    dedupKey: `dev:${stepId}:${after.length}`,
    payload: { before: baseStep.command, after, lineageKey: step.lineageKey, stepTitle: step.title },
  })
}

/**
 * 跑通时的两件小事：修复步骤跑通 → 对应坑帮上一次；然后看有没有坑可记。
 */
export function onStepOk(store: Store, taskId: string, stepId: string): void {
  const step = store.getStep(stepId)
  if (step?.sourceRef?.startsWith('lesson:') === true) {
    store.recordLessonHit(step.sourceRef.slice('lesson:'.length))
  }
  detectFixOffer(store, taskId, stepId)
}

/** 从坑的修法里抽第一条命令（围栏代码块优先），供"按这个修"插入步骤。 */
export function fixCommandOf(fixMd: string): string | null {
  const fenced = fixMd.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/)
  const cmd = (fenced?.[1] ?? fixMd).trim()
  if (cmd === '') return null
  return redact(cmd).text
}

function tailLines(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/)
  const tail = lines.slice(-6).join('\n')
  return tail.length > SYMPTOM_MAX ? `…${tail.slice(tail.length - SYMPTOM_MAX)}` : tail
}
