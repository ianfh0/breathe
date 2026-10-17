import type { BreathCount, Pace } from './pacing'

export interface Settings {
  rounds: number
  breaths: BreathCount
  pace: Pace
  muted: boolean
}

export interface HistoryEntry {
  id: string
  date: string
  rounds: number
  breaths: BreathCount
  pace: Pace
  retentions: number[]
}

const SETTINGS_KEY = 'breathe.settings'
const HISTORY_KEY = 'breathe.history'
const MAX_HISTORY = 80

export const DEFAULT_SETTINGS: Settings = {
  rounds: 3,
  breaths: 30,
  pace: 'medium',
  muted: false,
}

function isBreathCount(value: number): value is BreathCount {
  return value === 30 || value === 40 || value === 50
}

function isPace(value: unknown): value is Pace {
  return value === 'slow' || value === 'medium' || value === 'fast'
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    const rounds = Number(parsed.rounds)
    const breaths = Number(parsed.breaths)
    return {
      rounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 ? rounds : 3,
      breaths: isBreathCount(breaths) ? breaths : 30,
      pace: isPace(parsed.pace) ? parsed.pace : 'medium',
      muted: Boolean(parsed.muted),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as HistoryEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry) =>
        !!entry &&
        typeof entry.date === 'string' &&
        typeof entry.rounds === 'number' &&
        Array.isArray(entry.retentions) &&
        entry.retentions.every((value) => typeof value === 'number'),
    )
  } catch {
    return []
  }
}

export function saveSession(entry: HistoryEntry): void {
  const next = [entry, ...loadHistory()].slice(0, MAX_HISTORY)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}
