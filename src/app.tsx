import TextInput from 'ink-text-input'
import React, { useState, useEffect, useMemo, useCallback, FC, useLayoutEffect, useRef, Fragment } from 'react'
import {
  render,
  Box,
  Text,
  useApp,
  useInput,
  Key,
  useStdout,
  DOMElement,
  measureElement,
  useWindowSize,
  Spacer,
} from 'ink'

import { collapseHomedir } from './utils/collapse-homedir.ts'
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
              title: `${widget.name}, ${widget.status}`,
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
  const [expanded, setExpanded] = useState(false)

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
    } else if (input === 'e') {
      setExpanded(!expanded)
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
      <Box flexDirection="column" paddingY={1} paddingX={2}>
        <Text>Loading widgets...</Text>
      </Box>
    )
  }

  if (widgets.length === 0 || !widget) {
    return (
      <Box flexDirection="column" paddingY={1} paddingX={2}>
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
    <Box flexDirection="column" paddingRight={2} paddingBottom={1} maxWidth={100}>
      <Box justifyContent="center">
        <Text dimColor>{scrollOffset > 0 ? '▲ more' : ' '}</Text>
      </Box>
      <ScrollList ref={listRef} selectedIndex={index} height={rows - toolbarHeight - 4} onScroll={setScrollOffset}>
        {/* NOTE: Minimize dynamic height changes in list items, it makes the list flicker and jump */}
        {widgets.map((widget, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            <Box flexDirection="column" backgroundColor="black" marginLeft={2}>
              <WidgetPreview preview={widget.preview} expanded={i === index && expanded} />
            </Box>
            {!!confirmActionId && i === index ? (
              <Box>
                <Text>
                  › Confirm {widget.actions!.find(action => action.id === confirmActionId)!.name.toLowerCase()}?
                </Text>
                <Text dimColor> (y/n)</Text>
              </Box>
            ) : !!textActionId && i === index ? (
              <Box>
                <Text>{'› '}</Text>
                <Box flexGrow={1}>
                  <TextInput value={text} onChange={setText} />
                </Box>
              </Box>
            ) : (
              <Box>
                <Text>
                  {i === index ? (
                    <Text
                      bold
                      color={widget.status === 'working' ? 'green' : widget.status === 'blocked' ? 'red' : undefined}
                    >
                      {'› '}
                    </Text>
                  ) : widget.status === 'working' ? (
                    <>
                      <Text color="green">
                        <Spinner />
                      </Text>{' '}
                    </>
                  ) : widget.status === 'blocked' ? (
                    <Text color="red">{'? '}</Text>
                  ) : (
                    <Text dimColor>{'  '}</Text>
                  )}
                  <Text
                    bold
                    color={widget.status === 'idle' ? undefined : widget.status === 'blocked' ? 'red' : 'green'}
                  >
                    {widget.name}
                  </Text>
                </Text>
                <Spacer />
                <Text dimColor> {collapseHomedir(widget.cwd)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </ScrollList>
      <Box justifyContent="center">
        <Text dimColor>{scrollOffset < bottomOffset ? '▼ more' : ' '}</Text>
      </Box>

      <Box ref={toolbarRef} marginTop={1}>
        <Box flexDirection="column" marginLeft={2}>
          {!!widget.actions && (
            <Text dimColor wrap="truncate-end">
              {widget.actions.map((action, i) => (
                <Fragment key={i}>
                  {i > 0 ? ' · ' : ''}
                  {action.keymaps[0] === ' '
                    ? 'space'
                    : action.keymaps[0].length === 1
                      ? action.keymaps[0]
                      : action.keymaps[0].toLowerCase()}{' '}
                  to {action.name.toLowerCase()}
                </Fragment>
              ))}
              {' · '}
              {expanded ? 'e to collapse' : 'e to expand'}
            </Text>
          )}

          {!!widget.views && (
            <Box>
              <Text dimColor wrap="truncate-end">
                {widget.views.map((view, i) => (
                  <Fragment key={i}>
                    {i > 0 ? ' · ' : ''}
                    {view.keymaps[0] === ' '
                      ? 'space'
                      : view.keymaps[0].length === 1
                        ? view.keymaps[0]
                        : view.keymaps[0].toLowerCase()}{' '}
                    to view {view.name.toLowerCase()}
                  </Fragment>
                ))}
              </Text>
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

  const requiredLines = expanded ? Math.min(Math.max(5, lines.length), 15) : 5

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
