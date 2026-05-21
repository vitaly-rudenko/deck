export type Widget = {
  id: string
  name: string
  cwd: string
  status: 'idle' | 'busy' | 'blocked' | 'stale'
  lastUpdatedAt: Date
  preview: string

  views?: {
    id: string
    name: string
    keymaps: string[]
  }[]

  actions?: {
    id: string
    name: string
    keymaps: string[]
    text?: boolean
    confirm?: boolean
  }[]
}
