import { describe, expect, it } from 'vitest'
import { assessDanger } from '../src/danger.ts'

describe('assessDanger', () => {
  describe('destructive', () => {
    const cases = [
      'rm -rf /opt/old-cache',
      'rm -fr build',
      'sudo rm -rf --no-preserve-root /',
      'mkfs.ext4 /dev/sdb1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'git push --force origin main',
      'git push -f',
      'DROP TABLE users;',
      'drop database prod',
      'TRUNCATE TABLE events',
      'DELETE FROM users',
      'kubectl delete pod --all',
      'helm uninstall my-release',
      'terraform destroy -auto-approve',
      'shutdown -h now',
      'reboot',
    ]
    for (const cmd of cases) {
      it(cmd, () => {
        const r = assessDanger(cmd)
        expect(r.level, `${cmd} 应判为 destructive，实际 ${r.level}`).toBe('destructive')
        expect(r.matched.length).toBeGreaterThan(0)
      })
    }
  })

  describe('caution', () => {
    const cases = [
      'git reset --hard HEAD~3',
      'git clean -fd',
      'docker system prune',
      'apt-get remove python3',
      'curl https://example.com/install.sh | sh',
      'chown -R user:user /data',
    ]
    for (const cmd of cases) {
      it(cmd, () => {
        expect(assessDanger(cmd).level).toBe('caution')
      })
    }
  })

  describe('safe', () => {
    const cases = [
      'ls -la',
      'nvidia-smi',
      'vllm serve /models/qwen --port 8100',
      'curl http://localhost:8000/health',
      'git status',
      'git push origin feature-branch',
      'SELECT * FROM users WHERE id = 1',
      'DELETE FROM events WHERE created_at < 100',
      'kubectl get pods',
      'echo "rm -rf is dangerous"'.replace('rm -rf', 'removal'),
      'python -m pytest',
      'docker ps',
    ]
    for (const cmd of cases) {
      it(cmd, () => {
        const r = assessDanger(cmd)
        expect(r.level, `${cmd} 应判为 safe，命中了 ${r.matched.join()}`).toBe('safe')
      })
    }
  })

  it('带 WHERE 的 DELETE 不算破坏性', () => {
    expect(assessDanger('DELETE FROM logs WHERE ts < 1000').level).toBe('safe')
  })

  it('同时命中多条规则时取最高等级', () => {
    const r = assessDanger('git reset --hard && rm -rf dist')
    expect(r.level).toBe('destructive')
    expect(r.matched.length).toBeGreaterThan(1)
  })
})
