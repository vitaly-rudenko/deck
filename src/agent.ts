export type Agent = {
  id: string
  type: 'pi' | 'claude-code'
  status: 'idle' | 'working' | 'blocked' | 'stale'
  cwd: string
  preview: string
  signature: string
  provider: 'tmux'
  providerMetadata: unknown
  lastUpdatedAt: Date
}
