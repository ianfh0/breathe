import { registerSW } from 'virtual:pwa-register'
import { BreathAudio } from './audio'
import { average, formatDuration, formatWhen, pluralRounds } from './format'
import { BREATH_OPTIONS, PACE_LABEL, PACE_ORDER, PACING, formatPace } from './pacing'
import type { BreathCount, Pace } from './pacing'
import { GuidedSession } from './session'
import type { SessionHooks } from './session'
import {
  loadHistory,
  loadSettings,
  saveSession,
  saveSettings,
} from './storage'
import type { HistoryEntry, Settings } from './storage'
import './style.css'

if (import.meta.env.PROD) {
  registerSW({ immediate: true })
}

const rootQuery = document.querySelector<HTMLDivElement>('#app')
if (!rootQuery) throw new Error('Missing #app')
const root: HTMLDivElement = rootQuery

const audio = new BreathAudio()
let settings = loadSettings()
let session: GuidedSession | null = null
let sessionActive = false
let wakeLock: WakeLockSentinel | null = null
let stopPreview: (() => void) | null = null
let onEscape: (() => void) | null = null

const speakerOn = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 9.5h3.2L11 6.1v11.8l-3.8-3.4H4z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M15.2 9.1a3.8 3.8 0 0 1 0 5.8M17.1 7a6.4 6.4 0 0 1 0 10"/></svg>`
const speakerOff = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 9.5h3.2L11 6.1v11.8l-3.8-3.4H4z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M16 10l4 4M20 10l-4 4"/></svg>`
const pauseIcon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}

function iconButton(label: string, svg: string): HTMLButtonElement {
  const button = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': label,
    'data-control': 'true',
  })
  button.innerHTML = svg
  return button
}

function muteButton(): HTMLButtonElement {
  const button = iconButton(settings.muted ? 'Unmute' : 'Mute', settings.muted ? speakerOff : speakerOn)
  button.setAttribute('aria-pressed', settings.muted ? 'true' : 'false')
  button.addEventListener('click', () => {
    settings = { ...settings, muted: !settings.muted }
    saveSettings(settings)
    audio.setMuted(settings.muted)
    button.innerHTML = settings.muted ? speakerOff : speakerOn
    button.setAttribute('aria-label', settings.muted ? 'Unmute' : 'Mute')
    button.setAttribute('aria-pressed', settings.muted ? 'true' : 'false')
  })
  return button
}

function mount(screen: HTMLElement, name: string): void {
  stopPreview?.()
  stopPreview = null
  onEscape = null
  root.dataset.screen = name
  if (name !== 'session') root.dataset.phase = ''
  root.replaceChildren(screen)
}

function caption(current: Settings): string {
  return `${pluralRounds(current.rounds)} · ${current.breaths} breaths`
}

function createOrb(): HTMLDivElement {
  const orb = el('div', { class: 'orb', 'data-state': 'breath', 'aria-hidden': 'true' })
  orb.append(el('div', { class: 'orb-glow' }), el('div', { class: 'orb-body' }))
  orb.style.transform = 'scale(0.7)'
  return orb
}

function runPreview(orb: HTMLElement, getPace: () => Pace): () => void {
  let stopped = false
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const tween = (from: number, to: number, durationMs: number) =>
    new Promise<void>((resolve) => {
      if (reduced) {
        orb.style.transform = 'scale(0.72)'
        const start = performance.now()
        const frame = (now: number) => {
          if (stopped || now - start >= durationMs) {
            resolve()
            return
          }
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        return
      }
      const start = performance.now()
      const frame = (now: number) => {
        if (stopped) {
          resolve()
          return
        }
        const t = Math.min(1, (now - start) / durationMs)
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * t)
        orb.style.transform = `scale(${from + (to - from) * eased})`
        if (t < 1) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })

  const loop = async () => {
    while (!stopped) {
      const timing = PACING[getPace()]
      await tween(0.46, 1, timing.inhale)
      if (stopped) break
      await tween(1, 0.46, timing.exhale)
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}

function showSetup(): void {
  const screen = el('section', { class: 'screen' })
  const actions = el('div', { class: 'header-actions' })
  const history = el('button', { class: 'link-btn', type: 'button' }, ['History'])
  history.addEventListener('click', showHistory)
  actions.append(muteButton(), history)

  const header = el('header', { class: 'header' }, [
    el('h1', {}, ['Breathe']),
    actions,
  ])

  const orb = createOrb()
  orb.classList.add('is-setup')
  const line = el('p', { class: 'caption' }, [caption(settings)])
  const stage = el('div', { class: 'stage' }, [el('div', { class: 'orb-wrap' }, [orb, line])])

  const roundsValue = el('div', { class: 'value' }, [String(settings.rounds)])
  const fewer = el('button', {
    class: 'step-btn',
    type: 'button',
    'aria-label': 'Fewer rounds',
  })
  fewer.append(el('span', { class: 'glyph minus' }))
  const more = el('button', {
    class: 'step-btn',
    type: 'button',
    'aria-label': 'More rounds',
  })
  more.append(el('span', { class: 'glyph plus' }))

  const syncRounds = () => {
    roundsValue.textContent = String(settings.rounds)
    fewer.disabled = settings.rounds <= 1
    more.disabled = settings.rounds >= 10
    line.textContent = caption(settings)
  }
  fewer.addEventListener('click', () => {
    if (settings.rounds <= 1) return
    settings = { ...settings, rounds: settings.rounds - 1 }
    saveSettings(settings)
    syncRounds()
  })
  more.addEventListener('click', () => {
    if (settings.rounds >= 10) return
    settings = { ...settings, rounds: settings.rounds + 1 }
    saveSettings(settings)
    syncRounds()
  })
  syncRounds()

  const breathGroup = el('div', { class: 'segment', role: 'group', 'aria-label': 'Breaths' })
  const breathButtons = new Map<BreathCount, HTMLButtonElement>()
  for (const count of BREATH_OPTIONS) {
    const button = el('button', { type: 'button' }, [String(count)])
    button.addEventListener('click', () => {
      settings = { ...settings, breaths: count }
      saveSettings(settings)
      line.textContent = caption(settings)
      for (const [value, item] of breathButtons) {
        item.setAttribute('aria-pressed', value === settings.breaths ? 'true' : 'false')
      }
    })
    breathButtons.set(count, button)
    breathGroup.append(button)
  }
  for (const [value, item] of breathButtons) {
    item.setAttribute('aria-pressed', value === settings.breaths ? 'true' : 'false')
  }

  const paceGroup = el('div', { class: 'segment', role: 'group', 'aria-label': 'Pace' })
  const paceButtons = new Map<Pace, HTMLButtonElement>()
  for (const pace of PACE_ORDER) {
    const button = el('button', { type: 'button' }, [
      el('span', {}, [PACE_LABEL[pace]]),
      el('span', { class: 'meta' }, [formatPace(pace)]),
    ])
    button.addEventListener('click', () => {
      settings = { ...settings, pace }
      saveSettings(settings)
      for (const [value, item] of paceButtons) {
        item.setAttribute('aria-pressed', value === settings.pace ? 'true' : 'false')
      }
    })
    paceButtons.set(pace, button)
    paceGroup.append(button)
  }
  for (const [value, item] of paceButtons) {
    item.setAttribute('aria-pressed', value === settings.pace ? 'true' : 'false')
  }

  const fields = el('div', { class: 'fields' }, [
    el('div', {}, [
      el('p', { class: 'field-label' }, ['Rounds']),
      el('div', { class: 'stepper' }, [fewer, roundsValue, more]),
    ]),
    el('div', {}, [el('p', { class: 'field-label' }, ['Breaths']), breathGroup]),
    el('div', {}, [el('p', { class: 'field-label' }, ['Pace']), paceGroup]),
  ])

  const begin = el('button', { class: 'primary', type: 'button' }, ['Begin'])
  begin.addEventListener('click', () => {
    audio.unlock()
    audio.setMuted(settings.muted)
    startWake()
    showSession()
  })

  screen.append(
    header,
    stage,
    fields,
    el('p', { class: 'note' }, ['Sit or lie down, not in water or while driving.']),
    el('div', { class: 'actions' }, [begin]),
  )
  mount(screen, 'setup')
  stopPreview = runPreview(orb, () => settings.pace)
}

function showHistory(): void {
  const screen = el('section', { class: 'screen history' })
  const back = el('button', { class: 'link-btn', type: 'button' }, ['Back'])
  back.addEventListener('click', showSetup)
  const header = el('header', { class: 'header' }, [
    el('h1', {}, ['History']),
    el('div', { class: 'header-actions' }, [back]),
  ])
  const entries = loadHistory()
  if (entries.length === 0) {
    screen.append(header, el('p', { class: 'note' }, ['No sessions yet.']))
    mount(screen, 'history')
    return
  }
  const list = el('div', { class: 'history-list' })
  for (const entry of entries) list.append(historyArticle(entry))
  screen.append(header, list)
  mount(screen, 'history')
}

function historyArticle(entry: HistoryEntry): HTMLElement {
  const best = Math.max(...entry.retentions)
  const times = el('p', { class: 'times' })
  for (const ms of entry.retentions) {
    const span = el('span', {}, [formatDuration(ms)])
    if (ms === best) span.classList.add('is-best')
    times.append(span)
  }
  const breaths = entry.breaths ?? 30
  return el('article', { class: 'past' }, [
    el('h2', {}, [formatWhen(entry.date)]),
    el('p', { class: 'meta' }, [`${pluralRounds(entry.rounds)} · ${breaths} breaths`]),
    times,
  ])
}

function showSession(): void {
  const screen = el('section', { class: 'screen' })
  const round = el('p', { class: 'round-label' }, ['Round 1'])
  const pause = iconButton('Pause', pauseIcon)
  const header = el('header', { class: 'header' }, [
    round,
    el('div', { class: 'header-actions' }, [muteButton(), pause]),
  ])

  const orb = createOrb()
  orb.style.transform = 'scale(0.46)'
  const phase = el('h1', { class: 'phase' }, ['Breathe in'])
  phase.setAttribute('aria-live', 'polite')
  const count = el('p', { class: 'count', 'aria-hidden': 'true' }, ['1'])
  const sub = el('p', { class: 'sub' }, ['of 30'])
  const stage = el('div', { class: 'stage' }, [
    el('div', { class: 'composition' }, [orb, phase, count, sub]),
  ])

  const end = el('button', { class: 'text-btn session-end', type: 'button', 'data-control': 'true' }, [
    'End session',
  ])

  const overlay = el('div', { class: 'overlay' })
  overlay.hidden = true
  const resume = el('button', { class: 'primary', type: 'button', 'data-control': 'true' }, ['Resume'])
  const endPaused = el(
    'button',
    { class: 'text-btn', type: 'button', 'data-control': 'true' },
    ['End session'],
  )
  const panel = el('div', { class: 'overlay-panel' }, [
    el('p', { class: 'overlay-title' }, ['Paused']),
    resume,
    endPaused,
  ])
  overlay.append(panel)

  const setCount = (value: string) => {
    if (count.textContent !== value) count.textContent = value
  }

  const hooks: SessionHooks = {
    onRound: (current, total) => {
      round.textContent = `Round ${current} of ${total}`
    },
    onBreath: (direction, current, total) => {
      root.dataset.phase = 'breathe'
      phase.textContent = direction === 'in' ? 'Breathe in' : 'Breathe out'
      setCount(String(current))
      sub.textContent = `of ${total}`
      orb.dataset.state = 'breath'
    },
    onRetain: (elapsed) => {
      if (root.dataset.phase !== 'retain') {
        root.dataset.phase = 'retain'
        phase.textContent = 'Hold — let go'
        sub.textContent = 'Tap to breathe'
        orb.dataset.state = 'hold'
      }
      setCount(formatDuration(elapsed))
    },
    onRecover: (seconds) => {
      if (root.dataset.phase !== 'recover') {
        root.dataset.phase = 'recover'
        phase.textContent = 'Recovery breath — hold'
        sub.textContent = ''
        orb.dataset.state = 'full'
      }
      setCount(String(seconds))
    },
    onScale: (scale) => {
      orb.style.transform = `scale(${scale})`
    },
    onDone: (retentions) => {
      session = null
      onEscape = null
      stopWake()
      if (retentions.length > 0) {
        saveSession({
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          rounds: retentions.length,
          breaths: settings.breaths,
          pace: settings.pace,
          retentions,
        })
      }
      showSummary(retentions)
    },
  }

  const guided = new GuidedSession(settings, hooks, audio)
  session = guided

  const setPaused = (paused: boolean) => {
    if (!session) return
    if (paused) {
      session.pause()
      overlay.hidden = false
      pause.setAttribute('aria-label', 'Resume')
      resume.focus()
    } else {
      session.resume()
      overlay.hidden = true
      pause.setAttribute('aria-label', 'Pause')
    }
  }

  pause.addEventListener('click', () => setPaused(!guided.isPaused))
  resume.addEventListener('click', () => setPaused(false))
  end.addEventListener('click', () => guided.end())
  endPaused.addEventListener('click', () => guided.end())

  screen.append(header, stage, end, overlay)
  mount(screen, 'session')
  onEscape = () => setPaused(!guided.isPaused)
  root.dataset.phase = 'breathe'
  guided.start()
}

function showSummary(retentions: number[]): void {
  const screen = el('section', { class: 'screen summary' })
  const again = el('button', { class: 'primary', type: 'button' }, ['Again'])
  const done = el('button', { class: 'text-btn', type: 'button' }, ['Done'])
  again.addEventListener('click', () => {
    audio.unlock()
    audio.setMuted(settings.muted)
    startWake()
    showSession()
  })
  done.addEventListener('click', showSetup)

  screen.append(
    el('p', { class: 'eyebrow' }, [formatWhen(new Date().toISOString())]),
    el('h1', {}, ['Session']),
  )

  if (retentions.length === 0) {
    screen.append(el('p', { class: 'note' }, ['No holds this time.']))
  } else {
    const best = Math.max(...retentions)
    const stats = el('div', { class: 'stats' }, [
      el('div', { class: 'stat best' }, [
        el('p', { class: 'stat-label' }, ['Best']),
        el('p', { class: 'stat-value' }, [formatDuration(best)]),
      ]),
      el('div', { class: 'stat average' }, [
        el('p', { class: 'stat-label' }, ['Average']),
        el('p', { class: 'stat-value' }, [formatDuration(average(retentions))]),
      ]),
    ])
    const rows = el('div', { class: 'rounds' })
    retentions.forEach((ms, index) => {
      const row = el('div', { class: 'round-row' }, [
        el('span', {}, [`Round ${index + 1}`]),
        el('span', { class: 'time' }, [formatDuration(ms)]),
      ])
      if (ms === best) row.classList.add('is-best')
      rows.append(row)
    })
    screen.append(stats, rows)
  }

  screen.append(el('div', { class: 'actions pin' }, [again, done]))
  mount(screen, 'summary')
}

function startWake(): void {
  sessionActive = true
  void acquireWakeLock()
}

function stopWake(): void {
  sessionActive = false
  const current = wakeLock
  wakeLock = null
  if (!current) return
  void current.release().catch(() => undefined)
}

async function acquireWakeLock(): Promise<void> {
  if (!sessionActive || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch {
    wakeLock = null
  }
}

document.addEventListener('pointerdown', () => {
  audio.unlock()
}, { once: true })

root.addEventListener('pointerup', (event) => {
  if (root.dataset.phase !== 'retain' || !session || session.isPaused) return
  const target = event.target
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (element?.closest('[data-control]')) return
  session.endRetention()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    onEscape?.()
    return
  }
  if (event.key === ' ' && root.dataset.phase === 'retain' && session && !session.isPaused) {
    event.preventDefault()
    session.endRetention()
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sessionActive) void acquireWakeLock()
})

audio.setMuted(settings.muted)
showSetup()
