import { exec } from 'child_process'
import { promisify } from 'util'

import type { AgentSnapshot, AgentSnapshotProvider } from './agent-snapshot-provider'

const execAsync = promisify(exec)

type TmuxProviderMetadata = {
  paneId: string
  windowName: string
  windowIndex: number
}

export class TmuxAgentSnapshotProvider implements AgentSnapshotProvider {
  async capture(): Promise<AgentSnapshot[]> {
    const listPanesOutput = await execAsync(
      `tmux list-panes -s \
         -t home \
         -F '#{pane_id};;;#{window_name};;;#{pane_current_path};;;#{pane_pid};;;#{window_index}'`,
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
          windowName: parts[1],
          windowIndex: Number(parts[4]),
          cwd: parts[2],
          pid: Number(parts[3]),
        }
      })

    const agentSnapshots: AgentSnapshot[] = []
    for (const pane of panes) {
      const agentType = await getAgentSnapshotType(pane.pid)
      if (!agentType) continue

      const { status, preview, signature } = await getAgentSnapshot(agentType, pane.paneId)

      agentSnapshots.push({
        id: pane.paneId,
        type: agentType,
        cwd: pane.cwd,
        status,
        preview,
        signature,
        provider: 'tmux',
        providerMetadata: {
          paneId: pane.paneId,
          windowName: pane.windowName,
          windowIndex: pane.windowIndex,
        },
      })
    }

    return agentSnapshots
  }

  async focus(providerMetadata: TmuxProviderMetadata): Promise<void> {
    await execAsync(`tmux select-window -t ${providerMetadata.windowIndex}`)
    await execAsync(`tmux select-pane -t ${providerMetadata.paneId}`)
  }

  async prompt(providerMetadata: TmuxProviderMetadata, text: string, type: 'steer' | 'follow-up'): Promise<void> {
    const keys = type === 'steer' ? 'Enter' : 'S-Enter'

    // TODO: escape shell
    await execAsync(`tmux send-keys -t ${providerMetadata.paneId} "${text.replaceAll(/"/g, '\\"')}" ${keys}`)
  }

  async interrupt(providerMetadata: TmuxProviderMetadata): Promise<void> {
    await execAsync(`tmux send-keys -t ${providerMetadata.paneId} Escape`)
  }
}

// TODO: It feels like these are not specific to tmux and can be extracted to common (or parts of them)
async function getAgentSnapshotType(pid: number) {
  const psOutput = await execAsync('ps -eo pid,ppid,command', { encoding: 'utf8' })

  const processes = new Map<number, { parentPid: number; command: string }>()
  for (const line of psOutput.stdout.split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match) {
      const [, pid, parentPid, command] = match
      processes.set(+pid, { parentPid: +parentPid, command })
    }
  }

  const queue = [pid]
  while (queue.length > 0) {
    const currentPid = queue.shift()
    const process = currentPid !== undefined && processes.get(currentPid)
    if (!process) continue

    if (/^pi(\s|$)/.test(process.command)) return 'pi'
    if (/^claude(\s|$|-)/.test(process.command)) return 'claude-code'

    for (const [childPid, processInfo] of processes) {
      if (processInfo.parentPid === currentPid) {
        queue.push(childPid)
      }
    }
  }

  return undefined
}

async function getAgentSnapshot(agentType: AgentSnapshot['type'], paneId: string) {
  const capturePaneOutput = await execAsync(`tmux capture-pane -t ${paneId} -S -50 -J -p`)
  const stdout = capturePaneOutput.stdout.trim()

  if (agentType === 'pi') {
    return {
      signature: stdout,
      preview: stdout, // TODO: proper preview
      status:
        stdout.includes('Allow') && stdout.includes('enter select') //
          ? 'blocked'
          : stdout.includes('Working...')
            ? 'working'
            : 'idle',
    } as const
  } else if (agentType === 'claude-code') {
    return {
      signature: stdout,
      preview: stdout, // TODO: proper preview
      status:
        stdout.includes('Do you want to') && stdout.includes('1. Yes') && stdout.includes('Esc to cancel') //
          ? 'blocked'
          : stdout.includes('Working...')
            ? 'working'
            : 'idle',
    } as const
  } else {
    throw new Error(`Unknown agentType: ${agentType}`)
  }
}

const agentSnapshotProvider = new TmuxAgentSnapshotProvider()
const agentSnapshots = await agentSnapshotProvider.capture()
console.log(
  JSON.stringify(
    agentSnapshots.map(s => {
      const { signature, preview, ...rest } = s
      return rest
    }),
    null,
    2,
  ),
)
