import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import type { Provider } from './provider'
import type { Widget } from './widget'
import { setTimeout as setTimeoutAsync } from 'node:timers/promises'
import { basename } from 'node:path'

const execAsync = promisify(exec)

export class TmuxProvider implements Provider {
  #options

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
        cwd: pane.cwd,
        status: query.status,
        preview: query.preview,
        views: [{ id: 'primary', name: 'Primary', keymaps: ['v', '?'] }],
        shortcut: query.type === 'self' ? this.#options.shortcut : undefined,
        actions: [
          { id: 'focus', name: 'Focus', keymaps: ['Enter', 'f'], default: true },
          { id: 'prompt', name: 'Prompt', keymaps: [' ', 'p'], text: true },
          ...(query.status === 'working'
            ? [{ id: 'interrupt', name: 'Interrupt', keymaps: ['x'], confirm: true }]
            : []),
          ...(query.status === 'blocked' ? [{ id: 'allow', name: 'Allow', keymaps: ['a'] }] : []),
          ...(query.status === 'blocked' ? [{ id: 'deny', name: 'Deny', keymaps: ['d'] }] : []),
          { id: 'rename', name: 'Rename', keymaps: ['r'], text: true },
        ],
        // TODO: Current permission state + Shift+Tab emulation
      })
    }

    // Stable sort
    widgets.sort((a, b) => a.id.localeCompare(b.id))

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
    } else if (actionId === 'allow') {
      await execAsync(`tmux send-keys -t ${widgetId} Enter`)
    } else if (actionId === 'kill') {
      await execAsync(`tmux run-shell 'pkill -9 -P $(tmux display-message -t ${widgetId} -p "#{pane_pid}")'`).catch(
        () => {},
      )
    } else if (actionId === 'rename') {
      if (text) {
        await execAsync(`tmux set -p -t ${widgetId} @deck_widget_name "${text}"`)
      } else {
        await execAsync(`tmux set -pu -t ${widgetId} @deck_widget_name`)
      }
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
  const lines = stdout.split('\n')

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

        const allowIndex = lines.findIndex((line, i) => i > titleIndex && line.trimEnd().endsWith('Allow'))

        previewStartIndex = titleIndex
        previewEndIndex = allowIndex === -1 ? titleIndex : allowIndex - 1
        status = 'blocked'
      } else if (stdout.includes('Working...')) {
        const workingIndex = lines.findLastIndex(line => line.trimEnd().endsWith('Working...'))
        if (workingIndex === -1) {
          throw new Error('Could not find working index')
        }

        const thinkingIndex = lines.findLastIndex((line, i) => i < workingIndex && line.trim() === 'Thinking...')

        previewStartIndex = thinkingIndex === -1 ? 0 : thinkingIndex + 1
        previewEndIndex = workingIndex - 1
        status = 'working'
      } else {
        const inputEndIndex = lines.findLastIndex(
          line => line.trimStart().startsWith('─') && line.trimEnd().endsWith('─'),
        )
        if (inputEndIndex === -1) {
          throw new Error('Could not find input end index')
        }

        const inputStartIndex = lines.findLastIndex(
          (line, i) => i < inputEndIndex && line.trimStart().startsWith('─') && line.trimEnd().endsWith('─'),
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

    return { type: 'pi', signature: preview, preview, status } as const
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

        const yesIndex = lines.findIndex((line, i) => i > titleIndex && line.trimEnd().endsWith('1. Yes'))

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
        const inputEndIndex = lines.findLastIndex(
          line => line.trimStart().startsWith('─') && line.trimEnd().endsWith('─'),
        )
        if (inputEndIndex === -1) {
          throw new Error('Could not find input end index')
        }

        const inputStartIndex = lines.findLastIndex(
          (line, i) => i < inputEndIndex && line.trimStart().startsWith('─') && line.trimEnd().endsWith('─'),
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

    return { type: 'claude_code', signature: preview, preview, status } as const
  } else if (type === 'self') {
    return {
      type: 'self',
      status: 'idle',
    } as const
  } else {
    throw new Error(`Unknown type: ${type}`)
  }
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
