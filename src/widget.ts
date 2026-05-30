import type { SupportedColor } from './supported-color.ts'

export type Widget = {
  id: string
  name: string
  type: string
  color: SupportedColor
  cwd: string
  status: 'idle' | 'working' | 'blocked'
  preview?: string
  shortcut?: string

  views?: WidgetView[]
  actions?: WidgetAction[]
}

export type WidgetAction = {
  id: string
  default?: boolean
  name: string
  keymaps: string[]
  text?: boolean
  confirm?: boolean
}

export type WidgetView = {
  id: string
  name: string
  keymaps: string[]
}
