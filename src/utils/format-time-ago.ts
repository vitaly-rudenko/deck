export function formatTimeAgo(timestamp: number | undefined, now: number): string {
  if (!timestamp) {
    return 'unknown'
  }

  const diffMs = now - timestamp
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 5) return 'now'
  if (diffSec < 60) return '<1m'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  return `${diffHr}h`
}
