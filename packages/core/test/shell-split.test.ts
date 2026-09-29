import { describe, expect, it } from 'vitest'
import { classifyShellText, isCommandLike, splitShellCommands } from '../src/shell-split.ts'

const BS = '\\'

describe('splitShellCommands：按 shell 语法切，不按行切', () => {
  it('反斜杠续行是一条命令（原先一条 docker run 被拆成 5 步）', () => {
    const text = [`docker run -itd --name=x ${BS}`, `  --shm-size 1g ${BS}`, `  -v /home:/home ${BS}`, '  image:main'].join('\n')
    const r = splitShellCommands(text)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ startLine: 1, endLine: 4, text })
  })

  it('跨行的引号（多行 JSON 参数）是一条命令', () => {
    const text = [`vllm serve m ${BS}`, `  --kv '{`, '    "kv_role": "kv_consumer"', `  }'`, 'curl localhost'].join('\n')
    expect(splitShellCommands(text).map((c) => c.text.split('\n').length)).toEqual([4, 1])
  })

  it('注释挂到下一条命令上当标题；空行不算', () => {
    const r = splitShellCommands('docker stop x\n\n# 按需重启\ndocker start x\n# 可以移除\ndocker rm x')
    expect(r.map((c) => [c.comment, c.text])).toEqual([
      [null, 'docker stop x'],
      ['按需重启', 'docker start x'],
      ['可以移除', 'docker rm x'],
    ])
  })

  it('heredoc、for/if 块、管道续行', () => {
    const r = splitShellCommands('cat <<EOF > a.txt\nhello\nEOF\necho done\nfor i in 1 2; do\n  echo $i\ndone\nif [ -f x ]; then\n  echo y\nfi\nls |\n  grep a')
    expect(r.map((c) => c.text)).toEqual(['cat <<EOF > a.txt\nhello\nEOF', 'echo done', 'for i in 1 2; do\n  echo $i\ndone', 'if [ -f x ]; then\n  echo y\nfi', 'ls |\n  grep a'])
  })

  it('一行里的 ; 与 && 不拆；${VAR} 的大括号不当代码块', () => {
    expect(splitShellCommands('cd /x && make; echo ${HOME}\nls')).toHaveLength(2)
  })

  it('一组带说明的 export：每条一步', () => {
    const r = splitShellCommands('# 缓冲区\n\nexport HCCL_BUFFSIZE=512\n\n# 可用的卡\n\nexport ASCEND_RT_VISIBLE_DEVICES=2,3')
    expect(r.map((c) => [c.comment, c.text])).toEqual([
      ['缓冲区', 'export HCCL_BUFFSIZE=512'],
      ['可用的卡', 'export ASCEND_RT_VISIBLE_DEVICES=2,3'],
    ])
  })
})

describe('命令还是回显', () => {
  it('像命令的行', () => {
    expect(isCommandLike('docker images')).toBe(true)
    expect(isCommandLike('FOO=1 python a.py')).toBe(true)
    expect(isCommandLike('./start.sh')).toBe(true)
    expect(isCommandLike('Application startup complete.')).toBe(false)
    expect(isCommandLike('enable_prefix_caching')).toBe(false)
  })

  it('带提示符的是终端记录；日志、关键字是回显；其余是命令', () => {
    expect(classifyShellText('[root@host ~]# docker exec -it x bash\nroot@host:/w# ls')).toBe('output')
    expect(classifyShellText('(EngineCore pid=1) INFO 09-23 GPU KV cache size: 402,318 tokens')).toBe('output')
    expect(classifyShellText('enable_prefix_caching')).toBe('output')
    expect(classifyShellText('\n\ndocker images\n\n')).toBe('command')
    expect(classifyShellText('# 只有注释\nexport A=1')).toBe('command')
    expect(classifyShellText('\n\n\n')).toBe('empty')
  })
})
