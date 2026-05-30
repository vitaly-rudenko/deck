import type { SupportedColor } from './supported-color'

export type Spawner = {
  id: string
  type: string
  color: SupportedColor
  name: string
  text?: boolean
}
