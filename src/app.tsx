import TextInput from 'ink-text-input'
import React, { useState, useEffect, useMemo, useCallback, FC, useLayoutEffect, useRef } from 'react'
import { render, Box, Text, useApp, useInput, Key, useStdout, DOMElement, measureElement, useWindowSize } from 'ink'

import { collapseHomedir } from './utils/collapse-homedir.ts'
import { formatTimeAgo } from './utils/format-time-ago.ts'
import { TmuxProvider } from './tmux-provider.ts'
import type { Widget } from './widget.ts'
import type { Provider } from './provider.ts'
import { SwiftbarMenubar } from './integrations/swiftbar-menubar.ts'
import Spinner from 'ink-spinner'
import { ScrollList, ScrollListRef } from 'ink-scroll-list'

const terminalAppName = process.env.DECK_TERMINAL_APP_NAME
const swiftbarPluginsDir = process.env.DECK_SWIFTBAR_PLUGINS_DIR
const port = process.env.DECK_SWIFTBAR_PORT ? Number(process.env.DECK_SWIFTBAR_PORT) : undefined
const shortcut = process.env.DECK_SHORTCUT

const providers: Provider[] = [new TmuxProvider({ terminalAppName, shortcut })]

const App: React.FC = () => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [widgets, setWidgets] = useState<Widget[]>()

  useLayoutEffect(() => {
    stdout.write('\x1b[2J\x1b[H') // Resets the cursor to the top left corner
  }, [])

  useEffect(() => {
    async function fetch() {
      const newWidgets: Widget[] = []

      for (const provider of providers) {
        newWidgets.push(...(await provider.poll()))
      }

      setWidgets(newWidgets)
    }

    const intervalId = setInterval(fetch, 1000)
    fetch()

    return () => clearInterval(intervalId)
  }, [])

  return (
    <>
      <Dashboard
        widgets={widgets?.filter(widget => widget.type !== 'self')}
        // TODO: which provider?
        view={async (widgetId, viewId, height) => providers[0].view(widgetId, viewId, height)}
        onAction={async (widgetId, actionId, text) => providers[0].action(widgetId, actionId, text)}
        onExit={() => exit()}
      />

      {!!swiftbarPluginsDir && port !== undefined && (
        <SwiftbarMenubarComponent
          swiftbarPluginsDir={swiftbarPluginsDir}
          port={port}
          widgets={widgets}
          onAction={async (widgetId, actionId, text) => providers[0].action(widgetId, actionId, text)}
        />
      )}
    </>
  )
}

const SwiftbarMenubarComponent: React.FC<{
  swiftbarPluginsDir: string
  port: number
  widgets: Widget[] | undefined
  onAction: (widgetId: string, actionId: string, text?: string) => Promise<void>
}> = ({ swiftbarPluginsDir, port, widgets, onAction }) => {
  const [menubar, setMenubar] = useState<SwiftbarMenubar>()

  useEffect(() => {
    const menubar = new SwiftbarMenubar({ swiftbarPluginsDir, port, defaultIcon: '⚫️' })

    menubar.on('click', ({ id }) => {
      const [widgetId, actionId] = id.split(';;;')
      if (!actionId) return

      onAction(widgetId, actionId)
    })

    menubar.on('failure', ({ message }) => {
      console.error('SwiftbarMenubar failure:', message)
    })

    setMenubar(menubar)

    return () => {
      setMenubar(undefined)
      menubar.dispose()
    }
  }, [])

  useEffect(() => {
    if (!menubar) return

    async function update() {
      if (!widgets) {
        await menubar!.update({ icon: '🔵', children: [{ id: '_', title: 'No widgets yet' }] })
        return
      }

      let index = 0
      await menubar!.update({
        icon: widgets.some(widget => widget.status === 'blocked') //
          ? '🔴'
          : widgets.some(widget => widget.status === 'working')
            ? '🟢'
            : '⚪️',
        children: widgets
          .sort(a => (a.type === 'self' ? -1 : 1)) // Put 'self' widget on top
          .map(widget => {
            const defaultAction = widget.actions?.find(action => action.default)
            const id = defaultAction ? [widget.id, defaultAction.id].join(';;;') : '_'

            if (widget.type === 'self') {
              return {
                id,
                title: 'Deck',
                shortcut: widget.shortcut,
                children: widget.actions
                  ?.filter(action => !action.text && !action.default)
                  .map(action => ({ id: [widget.id, action.id].join(';;;'), title: action.name })),
              }
            }

            index++

            return {
              id,
              title:
                `${index} ` +
                (widget.name ? `${collapseHomedir(widget.cwd)} (${widget.name})` : collapseHomedir(widget.cwd)) +
                ` [${widget.status}, ${formatTimeAgo(widget.lastUpdatedAt?.getTime(), Date.now())}]`,
              shortcut: widget.shortcut,
              children: widget.actions
                ?.filter(action => !action.text && !action.default)
                .map(action => ({ id: [widget.id, action.id].join(';;;'), title: action.name })),
            }
          }),
      })
    }

    const intervalId = setInterval(update, 1000)
    update()

    return () => clearInterval(intervalId)
  }, [menubar, widgets])

  return null
}

const Dashboard: React.FC<{
  widgets: Widget[] | undefined
  view: (widgetId: string, viewId: string, height: number) => Promise<string>
  onAction: (widgetId: string, actionId: string, text?: string) => Promise<void>
  onExit: () => void
}> = ({ widgets, view: getView, onAction, onExit }) => {
  const { stdout } = useStdout()
  const { rows, columns } = useWindowSize()
  const listRef = useRef<ScrollListRef>(null)
  const toolbarRef = useRef<DOMElement>(null)
  const [toolbarHeight, setToolbarHeight] = useState(0)

  const [now, setNow] = useState(() => Date.now())
  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [textActionId, setTextActionId] = useState<string>()
  const [confirmActionId, setConfirmActionId] = useState<string>()
  const [viewId, setViewId] = useState<string>()
  const [view, setView] = useState<string>()
  const [scrollOffset, setScrollOffset] = useState(0)
  const [bottomOffset, setBottomOffset] = useState(0)

  useEffect(() => {
    if (toolbarRef.current) {
      setToolbarHeight(measureElement(toolbarRef.current).height)
    }

    if (listRef.current) {
      setBottomOffset(listRef.current?.getBottomOffset() ?? 0)
    }
  })

  useEffect(() => {
    const onResize = () => listRef.current?.remeasure()
    stdout?.on('resize', onResize)
    return () => {
      stdout?.off('resize', onResize)
    }
  }, [stdout])

  const widget = useMemo(() => widgets?.[index], [widgets, index])

  const handleAction = useCallback((widget: Widget, action: NonNullable<Widget['actions']>[number]) => {
    if (action.text) {
      setTextActionId(action.id)
    } else if (action.confirm) {
      setConfirmActionId(action.id)
    } else {
      onAction(widget.id, action.id)
    }
  }, [])

  const handleView = useCallback((_widget: Widget, view: NonNullable<Widget['views']>[number]) => {
    setViewId(view.id)
  }, [])

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!viewId) return

    async function fetch() {
      setView(await getView(widget!.id, viewId!, columns))
    }

    const intervalId = setInterval(fetch, 1000)
    fetch()

    return () => clearInterval(intervalId)
  }, [viewId])

  useInput((input, key) => {
    if (!widget || !widgets) {
      if (input === 'q' || key.escape) {
        onExit()
      }

      return
    }

    if (textActionId) {
      if (key.return) {
        onAction(widget.id, textActionId, text)

        setTextActionId(undefined)
        setText('')
      } else if (key.escape) {
        setTextActionId(undefined)
      }

      return
    }

    if (confirmActionId) {
      if (input === 'y') {
        onAction(widget.id, confirmActionId)
      }

      setConfirmActionId(undefined)

      return
    }

    if (viewId) {
      const view = widget.views?.find(view => view.id === viewId)

      if (!view || input === 'q' || view.keymaps.some(keymap => matchKeymap(keymap, input, key)) || key.escape) {
        setViewId(undefined)
        setView(undefined)
      }

      return
    }

    if (input === 'k' || key.upArrow) {
      setIndex(i => (i === 0 ? widgets.length - 1 : i - 1))
    } else if (input === 'j' || key.downArrow) {
      setIndex(i => (i === widgets.length - 1 ? 0 : i + 1))
    } else if (input === 'q' || key.escape) {
      onExit()
    } else if (/^[1-9]$/.test(input)) {
      const targetIndex = Number(input) - 1
      if (targetIndex < widgets.length) {
        setIndex(targetIndex)

        const targetWidget = widgets[targetIndex]
        const action = targetWidget.actions?.find(a => a.default)
        if (action) handleAction(targetWidget, action)
      }
    } else {
      const view = widget.views?.find(v => v.keymaps.some(k => matchKeymap(k, input, key)))
      if (view) handleView(widget, view)

      const action = widget.actions?.find(a => a.keymaps.some(k => matchKeymap(k, input, key)))
      if (action) handleAction(widget, action)
    }
  })

  if (!widgets) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>Loading widgets...</Text>
      </Box>
    )
  }

  if (widgets.length === 0 || !widget) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>No widgets yet</Text>
      </Box>
    )
  }

  if (viewId) {
    return (
      <Box flexDirection="column">
        {!!view &&
          view.split('\n').map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))}
        {!view && <Text>Loading view...</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingBottom={1} maxWidth={80}>
      <Box justifyContent="center">
        <Text dimColor>{scrollOffset > 0 ? '▲ more' : ' '}</Text>
      </Box>
      <ScrollList ref={listRef} selectedIndex={index} height={rows - toolbarHeight - 3} onScroll={setScrollOffset}>
        {widgets.map((widget, i) => (
          <Box key={i} flexDirection="column">
            <Text>
              {widget.status === 'working' ? (
                <>
                  <Spinner />
                  <Text>{'  '}</Text>
                </>
              ) : i === index ? (
                <Text bold>{'›  '}</Text>
              ) : (
                <>
                  <Text>{i + 1}. </Text>
                </>
              )}
              {widget.name ? (
                <>
                  <Text bold>{widget.name}</Text> in <Text>{collapseHomedir(widget.cwd)}</Text>
                </>
              ) : (
                <>
                  <Text bold>{collapseHomedir(widget.cwd)}</Text>
                </>
              )}
              <Text>: </Text>
              <Text color={widget.status === 'idle' ? 'white' : widget.status === 'blocked' ? 'red' : 'green'}>
                {widget.status}
              </Text>
              {widget.lastUpdatedAt ? `, ${formatTimeAgo(widget.lastUpdatedAt, now)}` : ''}
            </Text>
            <Box flexDirection="column" backgroundColor="black" marginLeft={3}>
              <WidgetPreview preview={widget.preview} expanded={i === index} />
            </Box>
            {!!textActionId && i === index && (
              <Box marginTop={1}>
                <Text>{'›  '}</Text>
                <Box backgroundColor="black" flexGrow={1}>
                  <TextInput value={text} onChange={setText} />
                </Box>
              </Box>
            )}
          </Box>
        ))}
      </ScrollList>
      <Box justifyContent="center">
        <Text dimColor>{scrollOffset < bottomOffset ? '▼ more' : ' '}</Text>
      </Box>

      <Box ref={toolbarRef}>
        <Box marginTop={1}>
          {!!confirmActionId && (
            <Box marginLeft={3}>
              <Text>Confirm? (y/n)</Text>
            </Box>
          )}

          {!!textActionId && (
            <Box flexDirection="column">
              <Box marginLeft={3}>
                <Text dimColor>enter to submit · escape to cancel</Text>
              </Box>
            </Box>
          )}

          {!textActionId && !confirmActionId && (
            <Box flexDirection="column" marginLeft={3}>
              {!!widget.actions && (
                <Box>
                  {widget.actions.map((action, i) => (
                    <Text key={action.id} dimColor>
                      {i > 0 ? ' · ' : ''}
                      {action.keymaps[0] === ' '
                        ? 'space'
                        : action.keymaps[0].length === 1
                          ? action.keymaps[0]
                          : action.keymaps[0].toLowerCase()}{' '}
                      to {action.name.toLowerCase()}
                    </Text>
                  ))}
                </Box>
              )}

              {!!widget.views && (
                <Box>
                  {widget.views.map((view, i) => (
                    <Text key={view.id} dimColor>
                      {i > 0 ? ' · ' : ''}
                      {view.keymaps[0] === ' '
                        ? 'space'
                        : view.keymaps[0].length === 1
                          ? view.keymaps[0]
                          : view.keymaps[0].toLowerCase()}{' '}
                      to view {view.name.toLowerCase()}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

const WidgetPreview: FC<{
  preview?: string
  expanded?: boolean
}> = ({ preview, expanded }) => {
  let lines = (preview ?? '').split('\n').map(line => line.trimEnd())

  const requiredLines = expanded ? 10 : 5

  let truncatedLines = 0
  let gapLines = Math.max(0, requiredLines - lines.length)

  if (lines.length > requiredLines) {
    truncatedLines = lines.length - requiredLines + 1
    lines = lines.slice(-requiredLines + 1)
  }

  return (
    <Box flexDirection="column">
      {truncatedLines > 0 && (
        <>
          <Text dimColor wrap="truncate-end">
            ({truncatedLines} more lines)
          </Text>
        </>
      )}
      {Array.from(new Array(gapLines), (_, i) => (
        <Text key={i} dimColor>
          ~
        </Text>
      ))}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line.trimEnd() || ' '}
        </Text>
      ))}
    </Box>
  )
}

function matchKeymap(keymap: string, input: string, key: Key) {
  return (keymap === 'Enter' && key.return) || keymap === input
}

render(React.createElement(App), { alternateScreen: true })

// Ensure the process always exits on signals, even if Ink's cleanup hangs.
// SIGKILL is uncatchable and the OS restores terminal settings on exit.
const forceExit = () => {
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000).unref()
  process.exit(0)
}

process.once('SIGINT', forceExit)
process.once('SIGTERM', forceExit)
