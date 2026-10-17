import type { BreathAudio } from './audio'
import { PACING } from './pacing'
import type { Settings } from './storage'

export type SessionPhase = 'breathe' | 'retain' | 'recover'

export interface SessionHooks {
  onRound: (round: number, total: number) => void
  onBreath: (direction: 'in' | 'out', count: number, total: number) => void
  onRetain: (elapsedMs: number) => void
  onRecover: (secondsLeft: number) => void
  onScale: (scale: number) => void
  onDone: (retentions: number[]) => void
}

const SCALE_EMPTY = 0.46
const SCALE_FULL = 1
const RECOVERY_INHALE_MS = 1500
const RECOVERY_HOLD_MS = 15000
const RECOVERY_RELEASE_MS = 700

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export class GuidedSession {
  private stopped = false
  private paused = false
  private finished = false
  private endedByUser = false
  private retainDone = false
  private resumeWaiters: Array<() => void> = []
  private retentions: number[] = []

  constructor(
    private readonly settings: Settings,
    private readonly hooks: SessionHooks,
    private readonly audio: BreathAudio,
  ) {}

  get isPaused(): boolean {
    return this.paused
  }

  start(): void {
    void this.run()
  }

  pause(): void {
    if (this.paused || this.stopped || this.finished) return
    this.paused = true
    this.audio.suspend()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.audio.resume()
    this.flushWaiters()
  }

  endRetention(): void {
    this.retainDone = true
  }

  end(): void {
    if (this.finished || this.stopped) return
    this.endedByUser = true
    this.stopped = true
    this.retainDone = true
    if (this.paused) this.resume()
    else this.flushWaiters()
  }

  private flushWaiters(): void {
    const waiters = this.resumeWaiters.splice(0)
    waiters.forEach((resume) => resume())
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.stopped) return
    await new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve)
    })
  }

  private async run(): Promise<void> {
    try {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const { rounds, breaths, pace } = this.settings
      const timing = PACING[pace]

      for (let round = 1; round <= rounds && !this.stopped; round += 1) {
        this.hooks.onRound(round, rounds)
        this.audio.chime('round')

        for (let breath = 1; breath <= breaths && !this.stopped; breath += 1) {
          this.hooks.onBreath('in', breath, breaths)
          this.audio.swell('in', timing.inhale / 1000)
          await this.animate(SCALE_EMPTY, SCALE_FULL, timing.inhale, reduced)
          if (this.stopped) break
          this.hooks.onBreath('out', breath, breaths)
          this.audio.swell('out', timing.exhale / 1000)
          await this.animate(SCALE_FULL, SCALE_EMPTY, timing.exhale, reduced)
        }

        if (this.stopped) break

        this.hooks.onRetain(0)
        this.hooks.onScale(SCALE_EMPTY)
        this.audio.chime('retain')
        const held = await this.retain()
        if (held > 0) this.retentions.push(held)
        if (this.stopped) break

        this.hooks.onRecover(15)
        this.hooks.onScale(SCALE_EMPTY)
        this.audio.chime('recover')
        this.audio.swell('in', RECOVERY_INHALE_MS / 1000)
        await this.animate(SCALE_EMPTY, SCALE_FULL, RECOVERY_INHALE_MS, reduced)
        if (this.stopped) break
        await this.countdown(RECOVERY_HOLD_MS)
        if (this.stopped) break
        this.audio.swell('out', RECOVERY_RELEASE_MS / 1000)
        await this.animate(SCALE_FULL, SCALE_EMPTY, RECOVERY_RELEASE_MS, reduced)
      }
    } finally {
      this.finish()
    }
  }

  private async retain(): Promise<number> {
    this.retainDone = false
    let elapsed = 0
    let last = performance.now()
    while (!this.retainDone && !this.stopped) {
      if (this.paused) {
        await this.waitWhilePaused()
        last = performance.now()
        continue
      }
      const now = performance.now()
      elapsed += now - last
      last = now
      this.hooks.onRetain(elapsed)
      await nextFrame()
    }
    return elapsed
  }

  private async countdown(durationMs: number): Promise<void> {
    let elapsed = 0
    let last = performance.now()
    let shown = 15
    while (elapsed < durationMs && !this.stopped) {
      if (this.paused) {
        await this.waitWhilePaused()
        last = performance.now()
        continue
      }
      const now = performance.now()
      elapsed += now - last
      last = now
      const left = Math.max(0, durationMs - elapsed)
      const next = Math.ceil(left / 1000)
      if (next !== shown) {
        shown = next
        this.hooks.onRecover(next)
      }
      await nextFrame()
    }
    if (!this.stopped) this.hooks.onRecover(0)
  }

  private async animate(
    from: number,
    to: number,
    durationMs: number,
    reduced: boolean,
  ): Promise<void> {
    if (reduced) this.hooks.onScale(to)
    let elapsed = 0
    let last = performance.now()
    while (elapsed < durationMs && !this.stopped) {
      if (this.paused) {
        await this.waitWhilePaused()
        last = performance.now()
        continue
      }
      const now = performance.now()
      elapsed += now - last
      last = now
      const t = Math.min(1, elapsed / durationMs)
      if (!reduced) {
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * t)
        this.hooks.onScale(from + (to - from) * eased)
      }
      if (t >= 1) break
      await nextFrame()
    }
    if (!this.stopped) this.hooks.onScale(to)
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.stopped = true
    this.audio.stopAll()
    if (!this.endedByUser && this.retentions.length > 0) this.audio.chime('done')
    this.hooks.onDone(this.retentions.slice())
  }
}
