/**
 * 后台任务。
 *
 * 起草要 40 秒到 4 分钟（推理型模型的思考量波动很大），不能占着 HTTP
 * 连接让用户干等——他会以为卡死了，刷新页面还会重复触发。
 *
 * 所以：立刻返回任务 id，进度经 WS 推送，用户可以切走再回来。
 */

export type JobStatus = 'running' | 'done' | 'failed'

export interface Job {
  id: string
  kind: string
  /** 关联的实体，用于前端判断这个任务跟当前页面是否有关。 */
  subjectId: string
  status: JobStatus
  startedAt: number
  endedAt: number | null
  error: string | null
  result: unknown
  /** 进度提示，如"思考中 12000 字"。让用户知道它还活着。 */
  progress: string | null
}

export interface JobEvents {
  onUpdate(job: Job): void
}

/**
 * 内存里的任务表。
 *
 * 不落库：进程重启后未完成的任务本来也接不回去（模型调用已经断了），
 * 落库只会留下永远 running 的僵尸记录。重启后用户重新点一下即可。
 */
export class Jobs {
  private readonly jobs = new Map<string, Job>()
  private readonly events: JobEvents
  private seq = 0

  constructor(events: JobEvents) {
    this.events = events
  }

  /**
   * 启动一个后台任务。
   *
   * @param dedupeKey 同一个 subject 上同类任务只跑一个——用户连点两次
   *   "让 QB 起草"不该产生两份 runbook。
   */
  start<T>(
    kind: string,
    subjectId: string,
    work: (report: (progress: string) => void) => Promise<T>,
  ): { job: Job; existing: boolean } {
    const running = [...this.jobs.values()].find(
      (j) => j.kind === kind && j.subjectId === subjectId && j.status === 'running',
    )
    if (running !== undefined) return { job: running, existing: true }

    const job: Job = {
      id: `job_${++this.seq}`,
      kind,
      subjectId,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      result: null,
      progress: null,
    }
    this.jobs.set(job.id, job)
    this.events.onUpdate(job)

    // 进度更新有节流：模型每几十毫秒就吐一批 token，全推出去会淹掉 WS
    let lastPush = 0
    const report = (progress: string): void => {
      job.progress = progress
      const now = Date.now()
      if (now - lastPush >= PROGRESS_THROTTLE_MS) {
        lastPush = now
        this.events.onUpdate(job)
      }
    }

    void work(report)
      .then((result) => {
        job.status = 'done'
        job.result = result
        job.endedAt = Date.now()
      })
      .catch((e: unknown) => {
        job.status = 'failed'
        job.error = e instanceof Error ? e.message : String(e)
        job.endedAt = Date.now()
      })
      .finally(() => {
        this.events.onUpdate(job)
        // 完成的任务保留一段时间供前端取结果，之后清掉避免无限增长
        setTimeout(() => this.jobs.delete(job.id), RETENTION_MS).unref?.()
      })

    return { job, existing: false }
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }

  /** 某个实体上正在跑的任务，用于前端恢复"进行中"状态。 */
  activeFor(subjectId: string): Job[] {
    return [...this.jobs.values()].filter(
      (j) => j.subjectId === subjectId && j.status === 'running',
    )
  }
}

/** 完成的任务保留多久。够前端取结果，也够用户刷新后看到失败原因。 */
const RETENTION_MS = 10 * 60_000

/** 进度推送的最小间隔。 */
const PROGRESS_THROTTLE_MS = 1000
