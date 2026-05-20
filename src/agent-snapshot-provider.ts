export type AgentSnapshotProvider = {
  capture(): Promise<AgentSnapshot[]>
  focus(providerId: unknown): Promise<void>
  prompt(providerId: unknown, text: string, type: 'steer' | 'follow-up'): Promise<void>
}

export type AgentSnapshot = {
  id: string
  type: 'pi' | 'claude-code'
  status: 'idle' | 'working' | 'blocked'
  cwd: string
  preview: string
  signature: string
  provider: 'tmux'
  providerMetadata: unknown
}
