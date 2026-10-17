import './style.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  let reloading = false
  const swUrl = `${import.meta.env.BASE_URL}sw.js`
  const scope = import.meta.env.BASE_URL

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })

  void navigator.serviceWorker
    .register(swUrl, { scope, updateViaCache: 'none' })
    .then((registration) => {
      const checkForUpdate = () => {
        void registration.update()
      }
      checkForUpdate()
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
    })
}

type Phase = 'hold-idle' | 'hold' | 'recover'

interface StoredSession {
  date: string
  holds: number[]
}

const LOG_KEY = 'breathe.holds.v2'
const RECOVER_MS = 15000

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing #app')

let phase: Phase = 'hold-idle'
let holdMs = 0
let recoverMsLeft = RECOVER_MS
let holdStartedAt = 0
let recoverEndsAt = 0
let raf = 0
let sessionHolds: number[] = []
let wakeLock: WakeLockSentinel | null = null
let audioCtx: AudioContext | null = null
let running = false

const shell = document.createElement('div')
shell.className = 'shell'

const stopBtn = document.createElement('button')
stopBtn.type = 'button'
stopBtn.className = 'stop'
stopBtn.textContent = 'Stop'
stopBtn.setAttribute('data-control', 'true')

const stage = document.createElement('button')
stage.type = 'button'
stage.className = 'stage'
stage.setAttribute('aria-label', 'Timer')

const label = document.createElement('p')
label.className = 'label'

const timeEl = document.createElement('p')
timeEl.className = 'time'
timeEl.setAttribute('aria-live', 'polite')

const logEl = document.createElement('div')
logEl.className = 'log'

const doneBtn = document.createElement('button')
doneBtn.type = 'button'
doneBtn.className = 'done'
doneBtn.textContent = 'Done'
doneBtn.hidden = true
doneBtn.setAttribute('data-control', 'true')

stage.append(label, timeEl, logEl)
shell.append(stopBtn, stage, doneBtn)
root.append(shell)

function formatHold(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatRecover(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return String(s)
}

function loadSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredSession[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistSessionHolds(): void {
  if (sessionHolds.length === 0) return
  const today = new Date().toISOString().slice(0, 10)
  const sessions = loadSessions().filter((s) => s.date !== today)
  sessions.unshift({ date: today, holds: sessionHolds.slice() })
  localStorage.setItem(LOG_KEY, JSON.stringify(sessions.slice(0, 120)))
}

function renderLog(): void {
  logEl.replaceChildren()
  for (const ms of sessionHolds) {
    const span = document.createElement('span')
    span.textContent = formatHold(ms)
    logEl.append(span)
  }
}

function setDisplay(): void {
  if (phase === 'recover') {
    label.textContent = 'Recover'
    timeEl.textContent = formatRecover(recoverMsLeft)
    doneBtn.hidden = true
    stage.setAttribute('aria-label', 'Recovering')
    return
  }
  label.textContent = 'Hold'
  timeEl.textContent = formatHold(holdMs)
  doneBtn.hidden = phase !== 'hold'
  stage.setAttribute(
    'aria-label',
    phase === 'hold-idle' ? 'Tap to start hold' : 'Tap when done holding',
  )
}

function unlockAudio(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch {
    audioCtx = null
  }
}

function playDoneTone(): void {
  if (!audioCtx) return
  const ctx = audioCtx
  const start = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(440, start)
  osc.frequency.exponentialRampToValueAtTime(330, start + 0.35)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + 0.5)
}

function vibrate(): void {
  if (typeof navigator.vibrate === 'function') navigator.vibrate(120)
}

async function acquireWakeLock(): Promise<void> {
  if (!running || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch {
    wakeLock = null
  }
}

function releaseWakeLock(): void {
  const current = wakeLock
  wakeLock = null
  if (current) void current.release().catch(() => undefined)
}

function setRunning(active: boolean): void {
  running = active
  if (active) void acquireWakeLock()
  else releaseWakeLock()
}

function cancelFrame(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function tick(): void {
  const now = performance.now()
  if (phase === 'hold') {
    holdMs = now - holdStartedAt
    setDisplay()
    raf = requestAnimationFrame(tick)
    return
  }
  if (phase === 'recover') {
    recoverMsLeft = recoverEndsAt - now
    if (recoverMsLeft <= 0) {
      recoverMsLeft = 0
      setDisplay()
      finishRecover()
      return
    }
    setDisplay()
    raf = requestAnimationFrame(tick)
  }
}

function startHold(fromIdle = false): void {
  cancelFrame()
  phase = 'hold'
  holdMs = 0
  holdStartedAt = performance.now()
  if (fromIdle) {
    unlockAudio()
    setRunning(true)
  }
  setDisplay()
  raf = requestAnimationFrame(tick)
}

function finishHold(): void {
  if (phase !== 'hold') return
  cancelFrame()
  const held = performance.now() - holdStartedAt
  sessionHolds.push(held)
  persistSessionHolds()
  renderLog()
  phase = 'recover'
  recoverMsLeft = RECOVER_MS
  recoverEndsAt = performance.now() + RECOVER_MS
  setDisplay()
  raf = requestAnimationFrame(tick)
}

function finishRecover(): void {
  cancelFrame()
  playDoneTone()
  vibrate()
  startHold(false)
}

function resetAll(): void {
  cancelFrame()
  phase = 'hold-idle'
  holdMs = 0
  recoverMsLeft = RECOVER_MS
  setRunning(false)
  setDisplay()
}

stage.addEventListener('click', () => {
  if (phase === 'hold-idle') startHold(true)
  else if (phase === 'hold') finishHold()
})

doneBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  if (phase === 'hold') finishHold()
})

stopBtn.addEventListener('click', () => {
  resetAll()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) void acquireWakeLock()
})

resetAll()
renderLog()
