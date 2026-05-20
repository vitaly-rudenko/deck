import TextInput from "ink-text-input";
import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";

import { collapseHomedir } from "./utils/collapse-homedir.js";
import { formatTimeAgo } from "./utils/format-time-ago.js";
import type { Agent } from "./agent.ts";

const agents: Agent[] = [
  {
    "id": "%44",
    "type": "pi",
    "cwd": "/Users/vitaly/workspace",
    "status": "idle",
    "preview": "test",
    "signature": "",
    "lastUpdatedAt": new Date(Date.now() - 60_000),
    "provider": "tmux",
    "providerMetadata": {
      "paneId": "%44",
      "windowName": "workspace",
      "windowIndex": 2
    }
  },
  {
    "id": "%49",
    "type": "claude-code",
    "cwd": "/Users/vitaly/projects/buddy",
    "status": "idle",
    "preview": "test",
    "signature": "",
    "lastUpdatedAt": new Date(Date.now() - 60_000),
    "provider": "tmux",
    "providerMetadata": {
      "paneId": "%49",
      "windowName": "projects/buddy",
      "windowIndex": 3
    }
  },
  {
    "id": "%50",
    "type": "pi",
    "cwd": "/Users/vitaly/projects/buddy",
    "status": "idle",
    "preview": "test",
    "signature": "",
    "lastUpdatedAt": new Date(Date.now() - 60_000),
    "provider": "tmux",
    "providerMetadata": {
      "paneId": "%50",
      "windowName": "projects/buddy",
      "windowIndex": 3
    }
  },
  {
    "id": "%56",
    "type": "pi",
    "cwd": "/Users/vitaly/temp/pi",
    "status": "idle",
    "preview": "test",
    "signature": "",
    "lastUpdatedAt": new Date(Date.now() - 60_000),
    "provider": "tmux",
    "providerMetadata": {
      "paneId": "%56",
      "windowName": "temp/pi",
      "windowIndex": 6
    }
  }
]

const App: React.FC = () => {
  const { exit } = useApp();

  return <Dashboard
    agents={agents}
    onFocus={agentId => console.log(agentId)}
    onPrompt={(agentId, text) => console.log(agentId, text)}
    onExit={() => exit()}
  />
}

const Dashboard: React.FC<{
  agents: Agent[]
  onFocus: (agentId: string) => void
  onPrompt: (agentId: string, text: string) => void
  onExit: () => void
}> = ({ agents, onFocus, onPrompt, onExit }) => {
  const [now, setNow] = useState(() => Date.now());
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState('select');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    const dateInterval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(dateInterval)
  }, [])

  useInput((input, key) => {
    if (mode === 'prompt') {
      if (key.return) {
        onPrompt(agents[index].id, prompt)

        setMode('select')
        setPrompt('')
      } else if (key.escape) {
        setMode('select')
      }

      return
    }

    if (input === "k" || key.upArrow) {
      setIndex((i) => i === 0 ? agents.length - 1 : i - 1)
    } else if (input === "j" || key.downArrow) {
      setIndex((i) => i === agents.length - 1 ? 0 : i + 1)
    } else if (input === "m" || input === " ") {
      setMode('prompt')
    } else if (key.return) {
      onFocus(agents[index].id)
    } else if (input === "q" || key.escape) {
      onExit()
    }
  });

  return (
    <Box flexDirection='column' paddingY={1}>
      {agents.length === 0 ? (
        <Box>
          <Text dimColor>No agent panes detected in session &quot;home&quot;</Text>
        </Box>
      ) : (
        <Box flexDirection="row">
          <Box flexDirection="column">
            <Text dimColor wrap="truncate">{"  "}Directory</Text>
            {agents.map((a, j) => (
              <Text key={a.id} wrap="truncate-end">{j === index ? '› ' : '  '}{collapseHomedir(a.cwd)}</Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end"> │ Status</Text>
            {agents.map(a => (
              <Text key={a.id} wrap="truncate-end"> │ {a.status}</Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end"> │ Updated</Text>
            {agents.map(a => (
              <Text key={a.id} wrap="truncate-end"> │ {formatTimeAgo(a.lastUpdatedAt.getTime(), now)}</Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end"> │ Preview</Text>
            {agents.map(a => (
              <Text key={a.id} wrap="truncate-end"> │ {a.preview}</Text>
            ))}
          </Box>
        </Box>
      )}

      {mode === 'prompt' && (
        <Box marginTop={1}>
          <Text>{"› "}</Text>
          <TextInput value={prompt} onChange={setPrompt} />
        </Box>
      )}
    </Box>
  )
}

render(React.createElement(App));
