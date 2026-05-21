import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import type { Provider } from './provider'
import type { Widget } from './widget'

const execAsync = promisify(exec)

export class TmuxProvider implements Provider {
  #paneIds = new Map<
    string,
    {
      lastSignature: string
      lastUpdatedAt: Date
    }
  >()

  async poll(): Promise<Widget[]> {
    const listPanesOutput = await execAsync(
      `tmux list-panes -s \
         -t home \
         -F '#{pane_id};;;#{pane_current_path};;;#{pane_pid}'`,
      { encoding: 'utf-8' },
    )

    const panes = listPanesOutput.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split(';;;')
        return { paneId: parts[0], cwd: parts[1], pid: Number(parts[2]) }
      })

    const widgets: Widget[] = []

    for (const pane of panes) {
      const query = await queryPane(pane.pid, pane.paneId)
      if (!query) continue

      // TODO: refactor
      let existingPane = this.#paneIds.get(pane.paneId)
      if (!existingPane) {
        existingPane = {
          lastSignature: query.signature,
          lastUpdatedAt: new Date(),
        }

        this.#paneIds.set(pane.paneId, existingPane)
      } else if (existingPane.lastSignature !== query.signature) {
        existingPane.lastUpdatedAt = new Date()
      }

      widgets.push({
        id: pane.paneId,
        name: query.name,
        cwd: pane.cwd,
        status: query.status,
        preview: query.preview,
        lastUpdatedAt: existingPane.lastUpdatedAt,
        views: [{ id: 'primary', name: 'Primary', keymaps: ['?'] }],
        actions: [
          { id: 'focus', name: 'Focus', keymaps: ['Enter'] },
          { id: 'prompt', name: 'Prompt', keymaps: [' ', 'm'], text: true },
          ...(query.status === 'busy' ? [{ id: 'interrupt', name: 'Interrupt', keymaps: ['x'], confirm: true }] : []),
          // TODO: Allow/deny permissions
        ],
        // TODO: Current permission state + Shift+Tab emulation
      })
    }

    return widgets
  }

  async view(widgetId: string, viewId: string, lines: number): Promise<string> {
    if (viewId !== 'primary') {
      throw new Error(`Unknown view: ${viewId}`)
    }

    const capturePaneOutput = await execAsync(`tmux capture-pane -t ${widgetId} -S -${lines} -J -p`)
    const stdout = capturePaneOutput.stdout.trim()
    return stdout.split('\n').slice(-lines).join('\n')
  }

  async action(widgetId: string, actionId: string, text?: string): Promise<void> {
    if (actionId === 'focus') {
      const displayMessageOutput = await execAsync(`tmux display-message -p -t ${widgetId} '#{window_index}'`)
      const windowIndex = Number(displayMessageOutput.stdout.trim())

      await execAsync(`tmux select-window -t ${windowIndex}`)
      await execAsync(`tmux select-pane -t ${widgetId}`)
    } else if (actionId === 'prompt') {
      if (!text) {
        throw new Error('No text provided')
      }

      // TODO: Steering / follow-up
      await execAsync(`tmux send-keys -t ${widgetId} "${text.replaceAll(/"/g, '\\"')}" Enter`)
    } else if (actionId === 'interrupt') {
      await execAsync(`tmux send-keys -t ${widgetId} Escape`)
    }
  }
}

async function queryPane(pid: number, paneId: string) {
  const psOutput = await execAsync('ps -eo pid,ppid,command', { encoding: 'utf8' })

  const processes = new Map<number, { parentPid: number; command: string }>()
  for (const line of psOutput.stdout.trim().split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match) {
      const [, pid, parentPid, command] = match
      processes.set(+pid, { parentPid: +parentPid, command })
    }
  }

  let type: 'pi' | 'claude_code' | undefined

  const queue = [pid]
  while (queue.length > 0) {
    const currentPid = queue.shift()
    const process = currentPid !== undefined && processes.get(currentPid)
    if (!process) continue

    if (/^pi(\s|$)/.test(process.command)) type = 'pi'
    if (/^claude(\s|$|-)/.test(process.command)) type = 'claude_code'

    for (const [childPid, processInfo] of processes) {
      if (processInfo.parentPid === currentPid) {
        queue.push(childPid)
      }
    }
  }

  if (!type) return undefined

  const capturePaneOutput = await execAsync(`tmux capture-pane -t ${paneId} -S -50 -J -p`)
  const stdout = capturePaneOutput.stdout.trim()

  const preview = stdout.split('\n')[0] // TODO: proper preview

  if (type === 'pi') {
    return {
      name: 'Pi',
      signature: stdout,
      preview,
      status:
        stdout.includes('Allow') && stdout.includes('enter select') //
          ? 'blocked'
          : stdout.includes('Working...')
            ? 'busy'
            : 'idle',
    } as const
  } else if (type === 'claude_code') {
    return {
      name: 'Claude',
      signature: stdout,
      preview,
      status:
        stdout.includes('Do you want to') && stdout.includes('1. Yes') && stdout.includes('Esc to cancel') //
          ? 'blocked'
          : stdout.includes('… (')
            ? 'busy'
            : 'idle',
    } as const
  } else {
    throw new Error(`Unknown type: ${type}`)
  }
}
