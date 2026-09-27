/**
 * 全文检索的中文处理。
 *
 * FTS5 的 unicode61 分词器把一串连续的汉字当成**一个**词元：
 * "集群部署"入库后只有 "集群部署" 这一个词，按单字 "集" 或词 "集群"
 * 都查不到（2026-09-27 实测）。所以两侧各做一次同样的切分：
 * - 入库：每段汉字额外展开成单字 + 二元组（"集 群 部 署 集群 群部 部署"），
 *   存进 fts_cjk 列一起索引
 * - 查询：一个字的段用单字，两个字以上的段用二元组，OR 起来
 *
 * 英文和数字照 unicode61 原样切（字母数字以外都是分隔符），原文列负责。
 */

/** 汉字（含扩展 A 与兼容区）。 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g

/** 入库用：把文本里的汉字段展开成单字 + 二元组，空格分隔。 */
export function cjkIndexText(...parts: Array<string | null | undefined>): string {
  const out: string[] = []
  for (const text of parts) {
    if (text === null || text === undefined) continue
    for (const m of text.matchAll(CJK_RUN)) {
      const run = m[0]
      for (const ch of run) out.push(ch)
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    }
  }
  return out.join(' ')
}

/** 查询用的词：英文/数字词（≥2 个字符）+ 汉字二元组（单字段用单字）。 */
export function ftsTerms(text: string, limit = 48): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    if (m[0].length >= 2) out.add(m[0].toLowerCase())
  }
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0]
    if (run.length === 1) out.add(run)
    else for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out].slice(0, limit)
}

/**
 * 生成 MATCH 表达式；没有可查的词时返回 null。
 * 每个词都加双引号：用户标题里的 `-`、`:`、`*`、`.` 等 FTS 语法字符
 * 不会再让查询报错（旧实现遇到 "v0.11.2" 这类词直接语法错误）。
 */
export function ftsMatch(text: string): string | null {
  const terms = ftsTerms(text)
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ')
}
