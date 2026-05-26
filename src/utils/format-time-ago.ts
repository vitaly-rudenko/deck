export function formatTimeAgo(timestamp: Date | number | undefined, now: number): string {
  if (timestamp === undefined) {
    return 'unknown'
  }

  const diffMs = now - (typeof timestamp === 'number' ? timestamp : timestamp.getTime())
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return 'a minute ago'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minutes ago`
  const diffHr = Math.floor(diffMin / 60)
  return `${diffHr} hours ago`
}
