import { customAlphabet } from 'nanoid'

// 去掉了容易混淆的字符（0/O、1/l/I），便于人肉念出来和抄写。
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const generate = customAlphabet(ALPHABET, 12)

/** 生成一个 QB 内部 id。带前缀便于在日志里一眼看出类型。 */
export function newId(prefix: string): string {
  return `${prefix}_${generate()}`
}

export const ids = {
  task: () => newId('tsk'),
  runbook: () => newId('rbk'),
  step: () => newId('stp'),
  evidence: () => newId('evd'),
  event: () => newId('evt'),
  skill: () => newId('skl'),
  skillVersion: () => newId('skv'),
  lesson: () => newId('lsn'),
  environment: () => newId('env'),
  question: () => newId('qst'),
  user: () => newId('usr'),
  lineage: () => newId('lin'),
  snapshot: () => newId('snp'),
  modelProfile: () => newId('mdl'),
  material: () => newId('mat'),
}
