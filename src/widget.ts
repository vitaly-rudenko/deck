export type Widget = {
  id: string
  name: string
  type: string
  cwd: string
  status: 'idle' | 'working' | 'blocked'
  preview?: string
  shortcut?: string

  views?: {
    id: string
    name: string
    keymaps: string[]
  }[]

  actions?: {
    id: string
    default?: boolean
    name: string
    keymaps: string[]
    text?: boolean
    confirm?: boolean
  }[]
}
