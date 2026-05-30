import { exec } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { Provider } from './provider'
import type { Widget } from './widget'
import { setTimeout as setTimeoutAsync } from 'node:timers/promises'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import { Spawner } from './spawner'

const execAsync = promisify(exec)

export class TmuxProvider implements Provider {
  #options
  #latestWidgets: Widget[] = []

  constructor(options: { terminalAppName?: string; shortcut?: string }) {
    this.#options = options
  }

  async poll(): Promise<Widget[]> {
    const listPanesOutput = await execAsync(
      `tmux list-panes -s \
         -t home \
         -F '#{pane_id};;;#{pane_current_path};;;#{pane_pid};;;#{@deck_widget_name}'`,
      { encoding: 'utf-8' },
    )

    const panes = listPanesOutput.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split(';;;')
        return { paneId: parts[0], cwd: parts[1], pid: Number(parts[2]), name: parts[3] }
      })

    const widgets: Widget[] = []

    for (const pane of panes) {
      const query = await queryPane(pane.pid, pane.paneId)
      if (!query) continue

      widgets.push({
        id: pane.paneId,
        name: pane.name || basename(pane.cwd),
        type: query.type,
        color:
          query.type === 'pi'
            ? 'green'
            : query.type === 'claude_code'
              ? 'yellow'
              : query.type === 'node'
                ? 'blue'
                : 'cyan',
        cwd: pane.cwd,
        status: query.status,
        preview: query.preview,
        views: [{ id: 'primary', name: 'Primary', keymaps: ['v', '?'] }],
        shortcut: query.type === 'self' ? this.#options.shortcut : undefined,
        actions: [
          { id: 'focus', name: 'Focus', keymaps: ['Enter', 'f'], default: true },
          ...(['pi', 'claude_code'].includes(query.type)
            ? [
                { id: 'prompt', name: 'Prompt', keymaps: [' ', 'p'], text: true },
                ...(query.status === 'working'
                  ? [{ id: 'interrupt', name: 'Interrupt', keymaps: ['x'], confirm: true }]
                  : []),
                ...(query.status === 'blocked' ? [{ id: 'allow', name: 'Allow', keymaps: ['a'] }] : []),
                ...(query.status === 'blocked' ? [{ id: 'deny', name: 'Deny', keymaps: ['d'] }] : []),
              ]
            : []),
          { id: 'kill', name: 'Kill', keymaps: ['X'], confirm: true },
          { id: 'rename', name: 'Rename', keymaps: ['r'], text: true },
        ],
        // TODO: Current permission state + Shift+Tab emulation
      })
    }

    // Stable sort
    // TODO: Should happen on app layer?
    widgets.sort((a, b) => a.id.localeCompare(b.id))

    this.#latestWidgets = widgets

    return widgets
  }

  async view(widgetId: string, viewId: string, height: number): Promise<string> {
    if (viewId !== 'primary') return ''

    const capturePaneOutput = await execAsync(`tmux capture-pane -t ${widgetId} -S -${height} -J -p -e`)
    const stdout = capturePaneOutput.stdout.trim()
    return stdout.split('\n').slice(-height).join('\n')
  }

  async action(widgetId: string, actionId: string, text?: string): Promise<void> {
    if (actionId === 'focus') {
      const displayMessageOutput = await execAsync(`tmux display-message -p -t ${widgetId} '#{window_index}'`)
      const windowIndex = Number(displayMessageOutput.stdout.trim())

      await execAsync(`tmux select-window -t ${windowIndex}`)
      await setTimeoutAsync(100)
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
      if (text) {
        // TODO: Steering / follow-up
        await execAsync(`tmux send-keys -t ${widgetId} "${text.replaceAll(/"/g, '\\"')}" Enter`)
      }
    } else if (actionId === 'interrupt' || actionId === 'deny') {
      await execAsync(`tmux send-keys -t ${widgetId} Escape`)
    } else if (actionId === 'kill') {
      const widget = this.#latestWidgets.find(w => w.id === widgetId)
      if (!widget) {
        // TODO: warn
      }

      await execAsync(`tmux send-keys -t ${widgetId} C-c`)

      // Agents require pressing Ctrl+C twice to exit
      if (widget?.type === 'claude_code' || widget?.type === 'pi') {
        await setTimeoutAsync(100)
        await execAsync(`tmux send-keys -t ${widgetId} C-c`)
      }
    } else if (actionId === 'allow') {
      await execAsync(`tmux send-keys -t ${widgetId} Enter`)
    } else if (actionId === 'rename') {
      if (text) {
        await execAsync(`tmux set -p -t ${widgetId} @deck_widget_name "${text}"`)
      } else {
        await execAsync(`tmux set -pu -t ${widgetId} @deck_widget_name`)
      }
    }
  }

  async spawners(): Promise<Spawner[]> {
    return [
      {
        id: 'claude_code',
        type: 'claude_code',
        color: 'yellow',
        name: 'Claude Code',
        text: true,
      },
      {
        id: 'pi',
        type: 'pi',
        color: 'green',
        name: 'Pi',
        text: true,
      },
    ]
  }

  async spawn(spawnerId: string, text?: string): Promise<void> {
    if (spawnerId === 'claude_code') {
      if (!text) return

      const cwd = expandHomedir(text)
      const cwdStat = await stat(cwd).catch(() => false)
      if (!cwdStat) return

      const { stdout: paneId } = await execAsync(`tmux new-window -t home: -c '${cwd}' -d -P -F '#{pane_id}'`)
      await execAsync(`tmux send-keys -t ${paneId.trim()} c Enter`)
    } else if (spawnerId === 'pi') {
      if (!text) return

      const cwd = expandHomedir(text)
      const cwdStat = await stat(cwd).catch(() => false)
      if (!cwdStat) return

      const { stdout: paneId } = await execAsync(`tmux new-window -t home: -c '${cwd}' -d -P -F '#{pane_id}'`)
      await execAsync(`tmux send-keys -t ${paneId.trim()} p Enter`)
    } else {
      throw new Error(`Unknown spawner: ${spawnerId}`)
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
      processes.set(Number(pid), { parentPid: Number(parentPid), command })
    }
  }

  let type: 'pi' | 'claude_code' | 'self' | 'node' | undefined

  const selfPid = process.pid
  const queue = [pid]
  while (queue.length > 0) {
    const currentPid = queue.shift()
    const process = currentPid !== undefined && processes.get(currentPid)
    if (!process) continue

    if (/^pi(\s|$)/.test(process.command)) type = 'pi'
    if (/^claude(\s|$|-)/.test(process.command)) type = 'claude_code'
    if (process.parentPid === selfPid) type = 'self'
    if (['npm start', 'npm run '].some(pattern => process.command.startsWith(pattern))) {
      type = 'node'
    }

    for (const [childPid, processInfo] of processes) {
      if (processInfo.parentPid === currentPid) {
        queue.push(childPid)
      }
    }
  }

  if (!type) return undefined

  const capturePaneOutput = await execAsync(`tmux capture-pane -t ${paneId} -S 0 -J -p`)
  const stdout = capturePaneOutput.stdout
  const lines = stdout.split('\n').map(line => line.trimEnd())

  if (type === 'pi') {
    let previewStartIndex = 0
    let previewEndIndex = Math.max(0, lines.length - 1)
    let status: Widget['status']

    try {
      if (stdout.includes('Allow') && stdout.includes('Deny') && stdout.includes('enter select')) {
        const titleIndex = lines.findLastIndex(line =>
          [
            //
            'Allow write to ',
            'Allow read from ',
            'Allow edit to ',
            'Allow `',
          ].some(title => line.trimStart().startsWith(title)),
        )
        if (titleIndex === -1) {
          throw new Error('Could not find title index')
        }

        const thinkingIndex = lines.findLastIndex((line, i) => i < titleIndex && line.trim() === 'Thinking...')
        const allowIndex = lines.findIndex((line, i) => i > titleIndex && line.endsWith('Allow'))

        previewStartIndex = thinkingIndex === -1 ? 0 : thinkingIndex + 1
        previewEndIndex = allowIndex === -1 ? titleIndex : allowIndex - 1
        status = 'blocked'
      } else if (stdout.includes('Working...')) {
        const workingIndex = lines.findLastIndex(line => line.endsWith('Working...'))
        if (workingIndex === -1) {
          throw new Error('Could not find working index')
        }

        let encounteredNonThinking = false
        const thinkingIndex = lines.findLastIndex((line, i) => {
          if (i < workingIndex) {
            const trimmed = line.trim()

            if (trimmed === 'Thinking...' && encounteredNonThinking) {
              return true
            }

            if (trimmed && trimmed !== 'Thinking...') {
              encounteredNonThinking = true
            }
          }

          return false
        })

        previewStartIndex = thinkingIndex === -1 ? 0 : thinkingIndex + 1
        previewEndIndex = workingIndex - 1
        status = 'working'
      } else {
        const inputEndIndex = lines.findLastIndex(line => line.trimStart().startsWith('─') && line.endsWith('─'))
        if (inputEndIndex === -1) {
          throw new Error('Could not find input end index')
        }

        const inputStartIndex = lines.findLastIndex(
          (line, i) => i < inputEndIndex && line.trimStart().startsWith('─') && line.endsWith('─'),
        )
        if (inputStartIndex === -1) {
          throw new Error('Could not find input start index')
        }

        const thinkingIndex = lines.findLastIndex((line, i) => i < inputStartIndex && line.trim() === 'Thinking...')

        previewStartIndex = thinkingIndex === -1 ? 0 : thinkingIndex + 1
        previewEndIndex = inputStartIndex - 1
        status = 'idle'
      }
    } catch (error) {
      console.error(error)
      status = 'idle'
    }

    const preview = normalizePreview(lines.slice(previewStartIndex, previewEndIndex + 1))

    return { type: 'pi', preview, status } as const
  } else if (type === 'claude_code') {
    let previewStartIndex = 0
    let previewEndIndex = Math.max(0, lines.length - 1)
    let status: Widget['status']

    try {
      if (stdout.includes('Do you want to ') && stdout.includes('1. Yes') && stdout.includes('Esc to cancel')) {
        const bashCommandIndex = lines.findLastIndex(line => line.trim() === 'Bash command')
        const titleIndex = lines.findLastIndex(line => line.trimStart().startsWith('Do you want to '))
        if (titleIndex === -1) {
          throw new Error('Could not find title index')
        }

        const yesIndex = lines.findIndex((line, i) => i > titleIndex && line.endsWith('1. Yes'))

        previewStartIndex = bashCommandIndex !== -1 ? bashCommandIndex + 1 : titleIndex
        previewEndIndex = yesIndex === -1 ? titleIndex : yesIndex - 1
        status = 'blocked'
      } else if (stdout.includes('… (')) {
        const workingIndex = lines.findLastIndex(line => line.includes('… ('))
        if (workingIndex === -1) {
          throw new Error('Could not find working index')
        }

        const messageIndex = lines.findLastIndex(
          (line, i) => i < workingIndex && (line.trimStart().startsWith('⏺ ') || line.trimStart().startsWith('❯ ')),
        )

        previewStartIndex = messageIndex === -1 ? 0 : messageIndex
        previewEndIndex = workingIndex
        status = 'working'
      } else {
        const inputEndIndex = lines.findLastIndex(line => line.trimStart().startsWith('─') && line.endsWith('─'))
        if (inputEndIndex === -1) {
          throw new Error('Could not find input end index')
        }

        const inputStartIndex = lines.findLastIndex(
          (line, i) => i < inputEndIndex && line.trimStart().startsWith('─') && line.endsWith('─'),
        )
        if (inputStartIndex === -1) {
          throw new Error('Could not find input start index')
        }

        const messageIndex = lines.findLastIndex(
          (line, i) => i < inputStartIndex && (line.trimStart().startsWith('⏺ ') || line.trimStart().startsWith('❯ ')),
        )

        const brewedForIndex = lines.findLastIndex(
          (line, i) => i > messageIndex && i < inputStartIndex && /^. [\w ]+ for [\d sm]+$/.test(line),
        )

        previewStartIndex = messageIndex === -1 ? 0 : messageIndex
        previewEndIndex = brewedForIndex !== -1 ? brewedForIndex - 1 : inputStartIndex - 1
        status = 'idle'
      }
    } catch (error) {
      console.error(error)
      status = 'idle'
    }

    const preview = normalizePreview(lines.slice(previewStartIndex, previewEndIndex + 1))

    return { type: 'claude_code', preview, status } as const
  } else if (type === 'self') {
    return {
      type: 'self',
      status: 'idle',
    } as const
  } else if (type === 'node') {
    return {
      type: 'node',
      preview: normalizePreview(lines),
      status: 'idle',
    } as const
  } else {
    throw new Error(`Unknown type: ${type}`)
  }
}

function expandHomedir(path: string) {
  return path.replace(/^~/, homedir())
}

function normalizePreview(lines: string[]) {
  lines = lines.map(line => line.replaceAll(/\s/g, ' ')) // Tabs mess up with widths

  // Remove empty lines before/after
  while (lines.at(0)?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()

  // De-indent
  const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.search(/\S/)))
  return lines.map(l => l.slice(minIndent)).join('\n')
}
