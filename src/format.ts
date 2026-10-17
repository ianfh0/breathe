export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  const totalTenths = Math.round(safe / 100)
  const tenths = totalTenths % 10
  const totalSeconds = Math.floor(totalTenths / 10)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`
}

export function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function pluralRounds(count: number): string {
  return count === 1 ? '1 round' : `${count} rounds`
}

export function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
