import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import type { Provider } from './provider'
import type { Widget } from './widget'

const execAsync = promisify(exec)

export class TmuxProvider implements Provider {
  #options
  #paneIds = new Map<string, { lastSignature: string; lastUpdatedAt?: Date }>()

  constructor(options: { terminalAppName?: string }) {
    this.#options = options
  }

  async poll(): Promise<Widget[]> {
    const listPanesOutput = await execAsync(
      `tmux list-panes -s \
         -t home \
         -F '#{pane_id};;;#{pane_current_path};;;#{pane_pid};;;#{pane_title}'`,
      { encoding: 'utf-8' },
    )

    const panes = listPanesOutput.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split(';;;')
        return {
          paneId: parts[0],
          cwd: parts[1],
          pid: Number(parts[2]),
          title: parts[3],
        }
      })

    const widgets: Widget[] = []

    for (const pane of panes) {
      const query = await queryPane(pane.pid, pane.paneId, pane.title)
      if (!query) continue

      // TODO: refactor
      let existingPane = this.#paneIds.get(pane.paneId)
      if (!existingPane) {
        existingPane = {
          lastSignature: query.signature ?? '',
          lastUpdatedAt: undefined,
        }

        this.#paneIds.set(pane.paneId, existingPane)
      } else if (existingPane.lastSignature !== query.signature) {
        existingPane.lastUpdatedAt = new Date()
      }

      widgets.push({
        id: pane.paneId,
        name: query.name,
        type: query.type,
        cwd: pane.cwd,
        status: query.status,
        preview: query.preview,
        lastUpdatedAt: existingPane.lastUpdatedAt,
        views: [{ id: 'primary', name: 'Primary', keymaps: ['?'] }],
        actions: [
          { id: 'focus', name: 'Focus', keymaps: ['Enter'], default: true },
          { id: 'prompt', name: 'Prompt', keymaps: [' ', 'm'], text: true },
          ...(query.status === 'working'
            ? [{ id: 'interrupt', name: 'Interrupt', keymaps: ['x'], confirm: true }]
            : []),
          ...(query.status === 'blocked' ? [{ id: 'allow', name: 'Allow', keymaps: ['a'] }] : []),
          ...(query.status === 'blocked' ? [{ id: 'deny', name: 'Deny', keymaps: ['d'] }] : []),
          { id: 'kill', name: 'Kill', keymaps: ['x'], confirm: true },
        ],
        // TODO: Current permission state + Shift+Tab emulation
      })
    }

    // Stable sort
    widgets.sort((a, b) => a.id.localeCompare(b.id))

    return widgets
  }

  async view(widgetId: string, viewId: string, height: number): Promise<string> {
    if (viewId !== 'primary') {
      throw new Error(`Unknown view: ${viewId}`)
    }

    const capturePaneOutput = await execAsync(`tmux capture-pane -t ${widgetId} -S -${height} -J -p`)
    const stdout = capturePaneOutput.stdout.trim()
    return stdout.split('\n').slice(-height).join('\n')
  }

  async action(widgetId: string, actionId: string, text?: string): Promise<void> {
    if (actionId === 'focus') {
      const displayMessageOutput = await execAsync(`tmux display-message -p -t ${widgetId} '#{window_index}'`)
      const windowIndex = Number(displayMessageOutput.stdout.trim())

      await execAsync(`tmux select-window -t ${windowIndex}`)
      await execAsync(`tmux select-pane -t ${widgetId}`)

      try {
        const terminalAppName = this.#options.terminalAppName
        if (terminalAppName) {
          await execAsync(`osascript -e 'tell application "${terminalAppName}" to activate'`)
        }
      } catch {
        // Ignore if not on macOS or terminal app isn't running
      }
    } else if (actionId === 'prompt') {
      if (!text) {
        throw new Error('No text provided')
      }

      // TODO: Steering / follow-up
      await execAsync(`tmux send-keys -t ${widgetId} "${text.replaceAll(/"/g, '\\"')}" Enter`)
    } else if (actionId === 'interrupt' || actionId === 'deny') {
      await execAsync(`tmux send-keys -t ${widgetId} Escape`)
    } else if (actionId === 'allow') {
      await execAsync(`tmux send-keys -t ${widgetId} Enter`)
    } else if (actionId === 'kill') {
      await execAsync(`tmux run-shell 'pkill -9 -P $(tmux display-message -t ${widgetId} -p "#{pane_pid}")'`).catch(
        () => {},
      )
    } else {
      throw new Error(`Unknown action: ${actionId}`)
    }
  }
}

async function queryPane(pid: number, paneId: string, paneTitle: string) {
  const psOutput = await execAsync('ps -eo pid,ppid,command', { encoding: 'utf8' })

  const processes = new Map<number, { parentPid: number; command: string }>()
  for (const line of psOutput.stdout.trim().split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match) {
      const [, pid, parentPid, command] = match
      processes.set(+pid, { parentPid: +parentPid, command })
    }
  }

  let type: 'pi' | 'claude_code' | 'self' | undefined

  const selfPid = process.pid

  const queue = [pid]
  while (queue.length > 0) {
    const currentPid = queue.shift()
    const process = currentPid !== undefined && processes.get(currentPid)
    if (!process) continue

    if (/^pi(\s|$)/.test(process.command)) type = 'pi'
    if (/^claude(\s|$|-)/.test(process.command)) type = 'claude_code'
    if (process.parentPid === selfPid) type = 'self'

    for (const [childPid, processInfo] of processes) {
      if (processInfo.parentPid === currentPid) {
        queue.push(childPid)
      }
    }
  }

  if (!type) return undefined

  const capturePaneOutput = await execAsync(`tmux capture-pane -t ${paneId} -S 0 -J -p`)
  const stdout = capturePaneOutput.stdout
  const lines = stdout.split('\n').map(line => line.trim())

  if (type === 'pi') {
    // TODO: Refactor & optimize
    let preview = ''
    if (stdout.includes('Allow') && stdout.includes('enter select')) {
      preview = lines.find(line => line.includes('Allow'))!
    } else if (stdout.includes('Working...')) {
      const linesBeforeWorking = lines.slice(
        0,
        lines.findIndex(line => line.includes('Working...')),
      )

      preview = linesBeforeWorking.slice(-5).join(' ')
    } else {
      let block: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const previousLine = lines[i - 1]
        const line = lines[i]

        // Prompt line starts, can stop querying
        if (line.includes('────────────────────')) {
          break
        }

        if (line) {
          if (stdout.includes('Thinking...')) {
            if (line === 'Thinking...') {
              block = []
              continue
            }
          } else if (!previousLine) {
            block = []
          }

          block.push(line)
        }
      }

      preview = block.join(' ')
    }

    return {
      // NOTE: pi doesn't set auto-title
      type: 'pi',
      signature: stdout,
      preview,
      status:
        stdout.includes('Allow') && stdout.includes('enter select') //
          ? 'blocked'
          : stdout.includes('Working...')
            ? 'working'
            : 'idle',
    } as const
  } else if (type === 'claude_code') {
    // TODO: Refactor & optimize
    let preview = ''
    if (stdout.includes('Do you want to') && stdout.includes('1. Yes') && stdout.includes('Esc to cancel')) {
      preview = lines.find(line => line.includes('Do you want to'))!
    } else {
      let blocks: string[][] = [[]]
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        // Prompt line starts, can stop querying
        if (line.includes('────────────────────')) {
          break
        }

        if (line) {
          if (line.startsWith('⏺ ') || line.startsWith('❯ ')) {
            blocks.push([])
          }

          blocks[blocks.length - 1].push(line)
        }
      }

      const blockEndIndex = blocks[blocks.length - 1].findIndex(
        line =>
          // Churned for 5s
          /^. [A-Z][a-z ]+ for [\d sm]+$/.test(line) ||
          // Simulating productivity… (5s)
          line.includes('… ('),
      )
      if (blockEndIndex !== -1) {
        blocks[blocks.length - 1] = blocks[blocks.length - 1].slice(0, blockEndIndex)
      }

      preview = blocks[blocks.length - 1].join(' ')
    }

    return {
      name: paneTitle.replace('✳ ', ''),
      type: 'claude_code',
      signature: stdout,
      preview,
      status:
        stdout.includes('Do you want to') && stdout.includes('1. Yes') && stdout.includes('Esc to cancel') //
          ? 'blocked'
          : stdout.includes('… (')
            ? 'working'
            : 'idle',
    } as const
  } else if (type === 'self') {
    return {
      type: 'self',
      status: 'idle',
    } as const
  } else {
    throw new Error(`Unknown type: ${type}`)
  }
}
