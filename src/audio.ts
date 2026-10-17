export type BreathDirection = 'in' | 'out'
export type Chime = 'round' | 'retain' | 'recover' | 'done'

const CHIMES: Record<Chime, { frequencies: number[]; gain: number }> = {
  round: { frequencies: [392, 493.88], gain: 0.035 },
  retain: { frequencies: [349.23, 523.25], gain: 0.05 },
  recover: { frequencies: [523.25, 659.25], gain: 0.05 },
  done: { frequencies: [392, 523.25, 659.25], gain: 0.045 },
}

export class BreathAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private nodes: Array<AudioBufferSourceNode | OscillatorNode> = []
  private muted = false
  private failed = false

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyMute()
  }

  unlock(): void {
    try {
      const ctx = this.ensure()
      if (ctx.state === 'suspended') void ctx.resume()
      const buffer = ctx.createBuffer(1, 1, 22050)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()
    } catch {
      this.failed = true
    }
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend()
  }

  resume(): void {
    if (this.failed) return
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }

  stopAll(): void {
    for (const node of this.nodes) {
      try {
        node.stop()
      } catch {
        /* already stopped */
      }
    }
    this.nodes = []
  }

  swell(kind: BreathDirection, duration: number): void {
    if (this.muted || this.failed || duration <= 0) return
    const ctx = this.tryContext()
    if (!ctx || !this.master || !this.noise) return
    const start = ctx.currentTime
    const attack = Math.max(0.05, duration * 0.45)
    const peak = kind === 'in' ? 0.15 : 0.11

    const noise = this.track(ctx.createBufferSource())
    noise.buffer = this.noise
    noise.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = kind === 'in' ? 740 : 320
    filter.Q.value = 0.7
    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.0001, start)
    noiseGain.gain.exponentialRampToValueAtTime(peak, start + attack)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    noise.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(this.master)
    noise.start(start)
    noise.stop(start + duration + 0.03)

    const tone = this.track(ctx.createOscillator())
    tone.type = 'sine'
    tone.frequency.value = kind === 'in' ? 196 : 146.83
    const toneGain = ctx.createGain()
    toneGain.gain.setValueAtTime(0.0001, start)
    toneGain.gain.exponentialRampToValueAtTime(kind === 'in' ? 0.04 : 0.028, start + attack)
    toneGain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    tone.connect(toneGain)
    toneGain.connect(this.master)
    tone.start(start)
    tone.stop(start + duration + 0.03)
  }

  chime(kind: Chime): void {
    if (this.muted || this.failed) return
    const ctx = this.tryContext()
    if (!ctx || !this.master) return
    const spec = CHIMES[kind]
    const start = ctx.currentTime
    spec.frequencies.forEach((frequency, index) => {
      const when = start + index * 0.045
      const osc = this.track(ctx.createOscillator())
      osc.type = 'sine'
      osc.frequency.setValueAtTime(frequency, when)
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, when)
      gain.gain.exponentialRampToValueAtTime(spec.gain, when + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.3)
      osc.connect(gain)
      gain.connect(this.master!)
      osc.start(when)
      osc.stop(when + 1.35)
    })
  }

  private tryContext(): AudioContext | null {
    try {
      return this.ensure()
    } catch {
      this.failed = true
      return null
    }
  }

  private ensure(): AudioContext {
    if (this.ctx && this.master && this.noise) return this.ctx
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) throw new Error('Audio unavailable')
    this.ctx = new Ctx()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(this.ctx.destination)
    this.noise = this.createNoise(this.ctx)
    return this.ctx
  }

  private applyMute(): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(this.muted ? 0 : 1, now)
  }

  private track<T extends AudioBufferSourceNode | OscillatorNode>(node: T): T {
    this.nodes.push(node)
    node.addEventListener('ended', () => {
      this.nodes = this.nodes.filter((item) => item !== node)
    })
    return node
  }

  private createNoise(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate * 2
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let brown = 0
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1
      brown = (brown + 0.02 * white) / 1.02
      data[index] = brown * 3.2
    }
    return buffer
  }
}
