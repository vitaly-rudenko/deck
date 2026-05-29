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
import { ScrollList, ScrollListRef } from 'ink-scroll-list'
import { ForegroundColorName } from 'chalk'

const terminalAppName = process.env.DECK_TERMINAL_APP_NAME
const swiftbarPluginsDir = process.env.DECK_SWIFTBAR_PLUGINS_DIR
const port = process.env.DECK_SWIFTBAR_PORT ? Number(process.env.DECK_SWIFTBAR_PORT) : undefined
const shortcut = process.env.DECK_SHORTCUT

const HEIGHTS = [1, 5, 15]
const DEFAULT_HEIGHT = 1

const providers: Provider[] = [new TmuxProvider({ terminalAppName, shortcut })]

function formatWidgetType(type: string) {
  if (type === 'pi') return 'pi'
  if (type === 'claude_code') return 'claude code'
  if (type === 'self') return 'deck'
  if (type === 'node') return 'node'

  return type
}

function getWidgetColor(type: string): ForegroundColorName | undefined {
  if (type === 'pi') return 'green'
  if (type === 'claude_code') return 'yellow'
  if (type === 'node') return 'blue'

  return undefined
}

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

  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [textActionId, setTextActionId] = useState<string>()
  const [confirmActionId, setConfirmActionId] = useState<string>()
  const [viewId, setViewId] = useState<string>()
  const [view, setView] = useState<string>()
  const [scrollOffset, setScrollOffset] = useState(0)
  const [bottomOffset, setBottomOffset] = useState(0)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [offsets, setOffsets] = useState<Record<string, number>>({})

  useLayoutEffect(() => {
    if (toolbarRef.current) {
      setToolbarHeight(measureElement(toolbarRef.current).height)
    }

    if (listRef.current) {
      setBottomOffset(listRef.current?.getBottomOffset() ?? 0)
    }
  })

  useEffect(() => {
    const onResize = () => listRef.current?.remeasure()
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
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
    // Clamp index
    setIndex(index => Math.min(Math.max(0, index), widgets ? widgets.length - 1 : 0))

    // Remove stale widgets
    // TODO: I think we can combine heights and offsets into one object
    setHeights(heights =>
      Object.fromEntries(Object.entries(heights).filter(([id]) => widgets?.some(widget => id === widget.id))),
    )
    setOffsets(offsets =>
      Object.fromEntries(Object.entries(offsets).filter(([id]) => widgets?.some(widget => id === widget.id))),
    )
  }, [widgets?.length])

  useEffect(() => {
    setOffsets({})
  }, [index, heights])

  useEffect(() => {
    setConfirmActionId(actionId => (widget?.actions?.some(action => action.id === actionId) ? actionId : undefined))
    setTextActionId(actionId => (widget?.actions?.some(action => action.id === actionId) ? actionId : undefined))
    setViewId(viewId => (widget?.views?.some(view => view.id === viewId) ? viewId : undefined))
  }, [widget?.actions, widget?.views])

  useEffect(() => {
    if (!widget || !viewId) return

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
    } else if (input === 'u' && key.ctrl) {
      const offsetAmount = heights[widget.id] && heights[widget.id] >= 10 ? 3 : 1

      setOffsets(offsets => ({
        ...offsets,
        [widget.id]: (offsets[widget.id] ?? 0) + offsetAmount,
      }))
    } else if (input === 'd' && key.ctrl) {
      const offsetAmount = heights[widget.id] && heights[widget.id] >= 10 ? 3 : 1

      setOffsets(offsets => ({
        ...offsets,
        [widget.id]: Math.max(0, (offsets[widget.id] ?? 0) - offsetAmount),
      }))
    } else if (input === '{') {
      const height = heights[widget.id] ?? DEFAULT_HEIGHT
      const index = HEIGHTS.indexOf(height)
      if (index > 0) {
        setHeights(heights => ({ ...heights, [widget.id]: HEIGHTS[index - 1] }))
      }
    } else if (input === '}') {
      const height = heights[widget.id] ?? DEFAULT_HEIGHT
      const index = HEIGHTS.indexOf(height)
      if (index < HEIGHTS.length - 1) {
        setHeights(heights => ({ ...heights, [widget.id]: HEIGHTS[index + 1] }))
      }
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
    <Box flexDirection="column">
      <Box justifyContent="center">
        <Text dimColor>{scrollOffset > 0 ? '▲ more' : ' '}</Text>
      </Box>

      {/* Widget list */}
      <ScrollList ref={listRef} selectedIndex={index} height={rows - toolbarHeight - 4} onScroll={setScrollOffset}>
        {/* NOTE: Minimize dynamic height changes in list items, it makes the list flicker and jump */}

        {/* Widget */}
        {widgets.map((widget, i) => (
          <Box
            key={i}
            flexDirection="column"
            borderStyle={i === index ? 'bold' : 'single'}
            borderColor={getWidgetColor(widget.type)}
            borderDimColor={i !== index}
          >
            {/* Preview */}
            <Box flexDirection="column" marginX={1}>
              <WidgetPreview
                preview={widget.preview ?? ''}
                height={heights[widget.id] ?? DEFAULT_HEIGHT}
                offset={offsets[widget.id] ?? 0}
                dimColor={i !== index}
              />
            </Box>

            {/* Widget bar */}
            <Box paddingX={1}>
              {!!confirmActionId && i === index ? (
                <>
                  <Text bold>{'› '}</Text>
                  <Text>Confirm</Text>
                  <Text> {widget.actions?.find(action => action.id === confirmActionId)?.name.toLowerCase()}?</Text>
                  <Text dimColor> (y/n)</Text>
                </>
              ) : !!textActionId && i === index ? (
                <>
                  <Text bold>{'› '}</Text>
                  <Box flexGrow={1}>
                    <TextInput value={text} onChange={setText} />
                  </Box>
                </>
              ) : (
                <>
                  <Text>
                    <Text bold={i === index} color={getWidgetColor(widget.type)}>
                      {widget.name}
                    </Text>
                    <Text color={getWidgetColor(widget.type)} dimColor>
                      {' '}
                      {formatWidgetType(widget.type)}
                    </Text>
                  </Text>
                  <Spacer />
                  <Text dimColor>{collapseHomedir(widget.cwd)}</Text>
                </>
              )}
            </Box>
          </Box>
        ))}
      </ScrollList>

      <Box justifyContent="center">
        <Text dimColor>{scrollOffset < bottomOffset ? '▼ more' : ' '}</Text>
      </Box>

      {/* Toolbar */}
      <Box ref={toolbarRef} marginTop={1} marginLeft={2} flexDirection="column">
        {/* Actions */}
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
            {' · { } to change height'}
          </Text>
        )}

        {/* Views */}
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
  )
}

const WidgetPreview: FC<{
  preview: string
  height: number
  offset: number
  dimColor?: boolean
}> = ({ preview, height, offset, dimColor }) => {
  const lines: (string | undefined)[] = preview.split('\n').map(line => line.trimEnd())

  // Pad to fill the required height
  while (lines.length < height) {
    lines.unshift(undefined)
  }

  // Truncate lines at the end (offset)
  const truncatedLinesEnd = []
  while (offset > 0 && lines.length > height) {
    truncatedLinesEnd.push(lines.pop())
    offset--
  }

  // Truncate lines at the start (doesn't fit)
  const truncatedLinesStart = []
  while (lines.length > height) {
    truncatedLinesStart.push(lines.shift())
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end" dimColor={line === undefined || dimColor}>
          {truncatedLinesStart.length > 0 && i === 0 && <Text dimColor>[+{truncatedLinesStart.length}] </Text>}
          {line || ' '}
          {truncatedLinesEnd.length > 0 && i === lines.length - 1 && (
            <Text dimColor> [+{truncatedLinesEnd.length}]</Text>
          )}
        </Text>
      ))}
    </Box>
  )
}

function matchKeymap(keymap: string, input: string, key: Key) {
  return (keymap === 'Enter' && key.return) || keymap === input
}

render(React.createElement(App), { alternateScreen: true, patchConsole: process.env.NODE_ENV !== 'dev' })

// Ensure the process always exits on signals, even if Ink's cleanup hangs.
// SIGKILL is uncatchable and the OS restores terminal settings on exit.
const forceExit = () => {
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000).unref()
  process.exit(0)
}

process.once('SIGINT', forceExit)
process.once('SIGTERM', forceExit)
