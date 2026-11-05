import { describe, expect, it } from 'vitest'
import { runJob, JOB_TIMEOUT_ERROR, MAX_ERROR_LENGTH, type JobDbAdapter, type JobStats } from '@/worker/jobRunner'
import { defineRegistry } from '@/worker/registry'

// Fake DB se stejnou sémantikou jako try_acquire_job_lock / finish_job_run (0040).
type Run = { id: number; job: string; status: string; stats?: JobStats; error?: string | null }

function fakeDb(clock: { now: number }) {
  const runs: Run[] = []
  const locks = new Map<string, { runId: number; until: number }>()
  const db: JobDbAdapter = {
    async tryAcquireJobLock(job, ttl) {
      const lock = locks.get(job)
      if (lock && lock.until >= clock.now) {
        runs.push({ id: runs.length + 1, job, status: 'skipped' })
        return null
      }
      if (lock) {
        const old = runs.find((r) => r.id === lock.runId)
        if (old && old.status === 'running') {
          old.status = 'failed'
          old.error = 'lock expired'
        }
      }
      const id = runs.length + 1
      runs.push({ id, job, status: 'running' })
      locks.set(job, { runId: id, until: clock.now + ttl * 1000 })
      return id
    },
    async finishJobRun(runId, status, stats, error) {
      const run = runs.find((r) => r.id === runId)
      if (!run || run.status !== 'running') return
      Object.assign(run, { status, stats, error })
      const lock = locks.get(run.job)
      if (lock && lock.runId === runId) lock.until = clock.now - 1
    },
  }
  return { db, runs }
}

describe('runJob', () => {
  it('úspěch zapíše succeeded se statistikou a uvolní zámek', async () => {
    const clock = { now: 0 }
    const { db, runs } = fakeDb(clock)
    const r = await runJob(db, 'sync', 60, async () => ({ n: 3 }))
    expect(r).toEqual({ status: 'succeeded', runId: 1, stats: { n: 3 } })
    const r2 = await runJob(db, 'sync', 60, async () => undefined)
    expect(r2.status).toBe('succeeded')
    expect(runs.map((x) => x.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('překryv: druhý souběžný běh je skipped a tělo se nespustí', async () => {
    const clock = { now: 0 }
    const { db, runs } = fakeDb(clock)
    let release!: () => void
    let calls = 0
    const slow = runJob(db, 'sync', 60, () => {
      calls++
      return new Promise<void>((res) => (release = res))
    })
    await Promise.resolve()
    const second = await runJob(db, 'sync', 60, async () => {
      calls++
    })
    expect(second).toEqual({ status: 'skipped' })
    release()
    expect((await slow).status).toBe('succeeded')
    expect(calls).toBe(1)
    expect(runs.map((x) => x.status)).toEqual(['succeeded', 'skipped'])
  })

  it('jiná úloha se zámkem neblokuje', async () => {
    const { db } = fakeDb({ now: 0 })
    const a = runJob(db, 'a', 60, () => new Promise<void>(() => {}))
    void a
    await Promise.resolve()
    expect((await runJob(db, 'b', 60, async () => {})).status).toBe('succeeded')
  })

  it('selhání zapíše failed s krátkou chybou a nevyhodí výjimku', async () => {
    const { db, runs } = fakeDb({ now: 0 })
    const r = await runJob(db, 'sync', 60, async () => {
      throw new Error('x'.repeat(2000))
    })
    expect(r.status).toBe('failed')
    expect(runs[0].status).toBe('failed')
    expect(runs[0].error).toHaveLength(MAX_ERROR_LENGTH)
    // Zámek je po selhání uvolněný.
    expect((await runJob(db, 'sync', 60, async () => {})).status).toBe('succeeded')
  })

  it('vypršelý TTL: nový běh převezme zámek, starý je failed (lock expired)', async () => {
    const clock = { now: 0 }
    const { db, runs } = fakeDb(clock)
    void runJob(db, 'sync', 60, () => new Promise<void>(() => {})) // zaseknutý běh
    await Promise.resolve()
    clock.now = 30_000
    expect((await runJob(db, 'sync', 60, async () => {})).status).toBe('skipped')
    clock.now = 61_000
    const r = await runJob(db, 'sync', 60, async () => ({ ok: 1 }))
    expect(r.status).toBe('succeeded')
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'lock expired' })
    expect(runs.map((x) => x.status)).toEqual(['failed', 'skipped', 'succeeded'])
  })

  it('pozdní finish převzatého běhu nic nepřepíše', async () => {
    const clock = { now: 0 }
    const { db, runs } = fakeDb(clock)
    let release!: () => void
    const stale = runJob(db, 'sync', 60, () => new Promise<void>((res) => (release = res)))
    await Promise.resolve()
    clock.now = 61_000
    await runJob(db, 'sync', 60, async () => {})
    release()
    await stale
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'lock expired' })
  })
})

describe('runJob — job_run nikdy nezůstane running', () => {
  it('tvrdá pojistka: tělo, které nestihne limit, zapíše failed a runJob se vrátí', async () => {
    const { db, runs } = fakeDb({ now: 0 })
    const r = await runJob(db, 'sync', 60, () => new Promise<void>(() => {}), { timeoutMs: 20 })
    expect(r).toEqual({ status: 'failed', runId: 1, error: JOB_TIMEOUT_ERROR })
    expect(runs[0]).toMatchObject({ status: 'failed', error: JOB_TIMEOUT_ERROR })
    // Zámek je uvolněný: další běh nečeká na TTL.
    expect((await runJob(db, 'sync', 60, async () => ({ ok: 1 }))).status).toBe('succeeded')
  })

  it('pozdní výjimka těla po pojistce neprojde ven a nic nepřepíše', async () => {
    const { db, runs } = fakeDb({ now: 0 })
    let fail!: (e: Error) => void
    const r = await runJob(db, 'sync', 60, () => new Promise<void>((_, rej) => (fail = rej)), { timeoutMs: 5, timeoutError: 'limit' })
    expect(r.status).toBe('failed')
    fail(new Error('pozdě'))
    await new Promise((res) => setTimeout(res, 5))
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'limit' })
  })

  it('rychlé tělo s pojistkou skončí normálně (časovač se uklidí)', async () => {
    const { db } = fakeDb({ now: 0 })
    expect(await runJob(db, 'sync', 60, async () => ({ n: 1 }), { timeoutMs: 10_000 })).toEqual({ status: 'succeeded', runId: 1, stats: { n: 1 } })
  })

  it('selhání zápisu konce: druhý pokus s prázdnými statistikami, výjimka ven nejde', async () => {
    const { db, runs } = fakeDb({ now: 0 })
    const finish = db.finishJobRun
    let calls = 0
    db.finishJobRun = async (...args) => {
      calls++
      if (calls === 1) throw new Error('stats nejdou uložit')
      return finish(...args)
    }
    const r = await runJob(db, 'sync', 60, async () => ({ big: 1 }))
    expect(r.status).toBe('succeeded')
    expect(calls).toBe(2)
    expect(runs[0]).toMatchObject({ status: 'succeeded', stats: { finishRetried: true } })
  })

  it('i když oba zápisy konce selžou, runJob nevyhodí (zbytek pohlídá TTL a kontrola úloh)', async () => {
    const { db } = fakeDb({ now: 0 })
    db.finishJobRun = async () => {
      throw new Error('db down')
    }
    await expect(runJob(db, 'sync', 60, async () => { throw new Error('tělo') })).resolves.toMatchObject({ status: 'failed', error: 'tělo' })
  })
})

describe('defineRegistry', () => {
  it('odmítne duplicitní jméno a neplatné TTL', () => {
    const run = async () => {}
    expect(() => defineRegistry([{ name: 'a', ttlSeconds: 60, run }, { name: 'a', ttlSeconds: 60, run }])).toThrow()
    expect(() => defineRegistry([{ name: 'a', ttlSeconds: 0, run }])).toThrow()
    expect(Object.keys(defineRegistry([{ name: 'a', ttlSeconds: 60, run }]))).toEqual(['a'])
  })
})
