import type { Widget } from './widget.ts'
import type { Spawner } from './spawner.ts'

export type Provider = {
  poll(): Promise<Widget[]>
  view(widgetId: string, viewId: string, height: number): Promise<string>
  action(widgetId: string, actionId: string, text?: string): Promise<void>

  spawners(): Promise<Spawner[]>
  spawn(spawnerId: string, text?: string): Promise<void>
}
