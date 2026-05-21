export type Widget = {
  id: string
  name?: string
  type: string
  cwd: string
  status: 'idle' | 'busy' | 'blocked'
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
