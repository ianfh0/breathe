export type Pace = 'slow' | 'medium' | 'fast'
export type BreathCount = 30 | 40 | 50

export interface PaceTiming {
  inhale: number
  exhale: number
}

/** Milliseconds. Inhale is the full breath; exhale is the passive release. */
export const PACING: Record<Pace, PaceTiming> = {
  slow: { inhale: 1500, exhale: 1000 },
  medium: { inhale: 1050, exhale: 700 },
  fast: { inhale: 750, exhale: 500 },
}

export const PACE_ORDER: Pace[] = ['slow', 'medium', 'fast']
export const BREATH_OPTIONS: BreathCount[] = [30, 40, 50]

export const PACE_LABEL: Record<Pace, string> = {
  slow: 'Slow',
  medium: 'Medium',
  fast: 'Fast',
}

export function formatPace(pace: Pace): string {
  const total = (PACING[pace].inhale + PACING[pace].exhale) / 1000
  return `${total}s`
}
