import TextInput from 'ink-text-input'
import React, { useState, useEffect, useMemo, useCallback, FC, useLayoutEffect, useRef, Fragment, use } from 'react'
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
import type { Spawner } from './spawner.ts'
import { SwiftbarMenubar } from './integrations/swiftbar-menubar.ts'
import { ScrollList, ScrollListRef } from 'ink-scroll-list'
import Spinner from 'ink-spinner'

const terminalAppName = process.env.DECK_TERMINAL_APP_NAME
const swiftbarPluginsDir = process.env.DECK_SWIFTBAR_PLUGINS_DIR
const port = process.env.DECK_SWIFTBAR_PORT ? Number(process.env.DECK_SWIFTBAR_PORT) : undefined
const shortcut = process.env.DECK_SHORTCUT

type WidgetState = {
  previewScroll: number
  previewHeight: number
}

const WIDGET_PREVIEW_HEIGHTS = [0, 1, 5, 15]
const DEFAULT_WIDGET_PREVIEW_HEIGHT = 1
const WIDGET_PREVIEW_SCROLL_PERCENTAGE = 0.5

function formatKeymaps(keymaps: string[]) {
  return keymaps[0] === ' ' //
    ? 'space'
    : keymaps[0].length === 1
      ? keymaps[0]
      : keymaps[0].toLowerCase()
}

function createWidgetState(): WidgetState {
  return { previewHeight: DEFAULT_WIDGET_PREVIEW_HEIGHT, previewScroll: 0 }
}

const providers: Provider[] = [new TmuxProvider({ terminalAppName, shortcut })]

const App: React.FC = () => {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [widgets, setWidgets] = useState<Widget[]>()
  const [spawners, setSpawners] = useState<Spawner[]>()
  const [mode, setMode] = useState<'dashboard' | 'spawner'>('dashboard')

  useLayoutEffect(() => {
    stdout.write('\x1b[2J\x1b[H') // Resets the cursor to the top left corner
  }, [])

  useEffect(() => {
    async function fetch() {
      const newWidgets: Widget[] = []
      const newSpawners: Spawner[] = []

      for (const provider of providers) {
        newWidgets.push(...(await provider.poll()))
        newSpawners.push(...(await provider.spawners()))
      }

      setWidgets(newWidgets)
      setSpawners(newSpawners)
    }

    const intervalId = setInterval(fetch, 1000)
    fetch()

    return () => clearInterval(intervalId)
  }, [])

  return (
    <>
      {/* TODO: Un-hardcode provider */}
      {mode === 'spawner' ? (
        <Spawners
          spawners={spawners}
          onSpawn={async (spawnerId, text) => providers[0].spawn(spawnerId, text)}
          onBack={() => setMode('dashboard')}
        />
      ) : (
        <Widgets
          widgets={widgets?.filter(widget => widget.type !== 'self')}
          fetchViewPreview={async (widgetId, viewId, height) => providers[0].view(widgetId, viewId, height)}
          onAction={async (widgetId, actionId, text) => providers[0].action(widgetId, actionId, text)}
          onSpawn={() => setMode('spawner')}
          onExit={() => exit()}
        />
      )}

      {!!swiftbarPluginsDir && port !== undefined && (
        <Swiftbar
          swiftbarPluginsDir={swiftbarPluginsDir}
          port={port}
          widgets={widgets}
          onAction={async (widgetId, actionId, text) => providers[0].action(widgetId, actionId, text)}
        />
      )}
    </>
  )
}

const Swiftbar: React.FC<{
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

const Spawners: React.FC<{
  spawners: Spawner[] | undefined
  onSpawn: (spawnerId: string, text?: string) => Promise<void>
  onBack: () => void
}> = ({ spawners, onSpawn, onBack }) => {
  const { rows } = useWindowSize()
  const { stdout } = useStdout()

  const listRef = useRef<ScrollListRef>(null)
  const toolbarRef = useRef<DOMElement>(null)

  const [spawnerIndex, setSpawnerIndex] = useState(0)
  const [spawningText, setSpawningText] = useState('')
  const [isSpawning, setIsSpawning] = useState(false)

  const [toolbarHeight, setToolbarHeight] = useState(0)
  const [spawnersListScroll, setSpawnersListScroll] = useState(0)
  const [spawnersListBottomOffset, setSpawnersListBottomOffset] = useState(0)

  const spawner = useMemo(() => spawners?.[spawnerIndex], [spawners, spawnerIndex])

  const canSpawnersListBeScrolledUp = useMemo(() => spawnersListScroll > 0, [spawnersListScroll])
  const canSpawnersListBeScrolledDown = useMemo(
    () => spawnersListScroll < spawnersListBottomOffset,
    [spawnersListScroll, spawnersListBottomOffset],
  )
  const spawnersListHeight = useMemo(
    () => rows - toolbarHeight - (canSpawnersListBeScrolledUp || canSpawnersListBeScrolledDown ? 4 : 2),
    [rows, toolbarHeight, canSpawnersListBeScrolledUp, canSpawnersListBeScrolledDown],
  )

  useLayoutEffect(() => {
    if (toolbarRef.current) setToolbarHeight(measureElement(toolbarRef.current).height)
    if (listRef.current) setSpawnersListBottomOffset(listRef.current?.getBottomOffset() ?? 0)
  }, [rows, spawnersListScroll])

  useEffect(() => {
    const onResize = () => listRef.current?.remeasure()
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useInput((input, key) => {
    if (!spawners) return

    if (spawner && isSpawning) {
      if (key.return) {
        onSpawn(spawner.id, spawningText)
        onBack()
      } else if (key.escape) {
        setSpawningText('')
        setIsSpawning(false)
      }

      return
    }

    if (input === 'k' || key.upArrow) {
      setSpawnerIndex(i => (i === 0 ? spawners.length - 1 : i - 1))
    } else if (input === 'j' || key.downArrow) {
      setSpawnerIndex(i => (i === spawners.length - 1 ? 0 : i + 1))
    } else if (key.return || input === ' ') {
      const spawner = spawners[spawnerIndex]

      if (spawner.text) {
        setIsSpawning(true)
      } else if (key.return) {
        onSpawn(spawner.id)
        onBack()
      }
    } else if (key.escape) {
      onBack()
    }
  })

  if (!spawners) {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text>Loading spawners...</Text>
      </Box>
    )
  }

  if (spawners.length === 0 || !spawner) {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text>No spawners available</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {(canSpawnersListBeScrolledUp || canSpawnersListBeScrolledDown) && (
        <Box justifyContent="center">
          <Text dimColor>{canSpawnersListBeScrolledUp ? '▲ more' : ' '}</Text>
        </Box>
      )}

      <ScrollList
        ref={listRef}
        selectedIndex={spawnerIndex}
        height={spawnersListHeight}
        onScroll={setSpawnersListScroll}
      >
        {spawners.map(s => (
          <Box
            key={s.id}
            flexDirection="column"
            borderStyle={s.id === spawners[spawnerIndex].id ? 'bold' : 'single'}
            borderColor={s.color}
            borderDimColor={s.id !== spawners[spawnerIndex].id}
            marginX={1}
          >
            <Box paddingX={1}>
              <Text bold={s.id === spawner.id} color={s.color}>
                {s.name}
              </Text>
              {isSpawning && s.id === spawner.id ? (
                <>
                  <Text color={s.color} bold>
                    {' › '}
                  </Text>
                  <Box flexGrow={1}>
                    <TextInput value={spawningText} onChange={setSpawningText} />
                  </Box>
                </>
              ) : (
                <Text color={s.color} dimColor>
                  {' tmux'}
                </Text>
              )}
            </Box>
          </Box>
        ))}
      </ScrollList>

      {(canSpawnersListBeScrolledUp || canSpawnersListBeScrolledDown) && (
        <Box justifyContent="center">
          <Text dimColor>{canSpawnersListBeScrolledDown ? '▼ more' : ' '}</Text>
        </Box>
      )}

      <Box ref={toolbarRef} marginTop={1} marginX={2}>
        <Text dimColor>enter to spawn · esc to cancel</Text>
      </Box>
    </Box>
  )
}

const Widgets: React.FC<{
  widgets: Widget[] | undefined
  fetchViewPreview: (widgetId: string, viewId: string, height: number) => Promise<string>
  onAction: (widgetId: string, actionId: string, text?: string) => Promise<void>
  onSpawn: () => void
  onExit: () => void
}> = ({ widgets, fetchViewPreview, onAction, onSpawn, onExit }) => {
  // EXTERNAL
  const { stdout } = useStdout()
  const { rows, columns } = useWindowSize()

  // REFS
  const listRef = useRef<ScrollListRef>(null)
  const toolbarRef = useRef<DOMElement>(null)

  // STATE
  const [widgetIndex, setWidgetIndex] = useState(0)
  const [actionId, setActionId] = useState<string>()
  const [viewId, setViewId] = useState<string>()

  const [toolbarHeight, setToolbarHeight] = useState(0)
  const [widgetsListScroll, setWidgetsListScroll] = useState(0)
  const [widgetsListBottomOffset, setWidgetsListBottomOffset] = useState(0)

  const [actionText, setActionText] = useState('')
  const [viewPreview, setViewPreview] = useState<string>()
  const [widgetStates, setWidgetStates] = useState<Record<string, WidgetState>>({})

  // COMPUTED
  const widget = useMemo(() => widgets?.[widgetIndex], [widgets, widgetIndex])
  const action = useMemo(() => widget?.actions?.find(action => action.id === actionId), [actionId, widget])
  const view = useMemo(() => widget?.views?.find(view => view.id === viewId), [viewId, widget])

  const canWidgetsListBeScrolledUp = useMemo(() => widgetsListScroll > 0, [widgetsListScroll])
  const canWidgetsListBeScrolledDown = useMemo(
    () => widgetsListScroll < widgetsListBottomOffset,
    [widgetsListScroll, widgetsListBottomOffset],
  )
  const widgetsListHeight = useMemo(
    () => rows - toolbarHeight - (canWidgetsListBeScrolledUp || canWidgetsListBeScrolledDown ? 4 : 2),
    [rows, toolbarHeight, canWidgetsListBeScrolledUp, canWidgetsListBeScrolledDown],
  )

  // METHODS
  const changeWidgetPreviewHeight = useCallback((widgetId: string, direction: 'expand' | 'shrink') => {
    setWidgetStates(ws => {
      const widgetState = ws[widgetId] ?? createWidgetState()
      const oldIndex = WIDGET_PREVIEW_HEIGHTS.indexOf(widgetState.previewHeight)
      const newIndex = direction === 'expand' ? oldIndex + 1 : oldIndex - 1

      return newIndex >= 0 && newIndex < WIDGET_PREVIEW_HEIGHTS.length
        ? { ...ws, [widgetId]: { ...widgetState, previewHeight: WIDGET_PREVIEW_HEIGHTS[newIndex] } }
        : ws
    })
  }, [])

  const scrollWidgetPreview = useCallback(
    (widgetId: string, direction: 'up' | 'down') => {
      setWidgetStates(ws => {
        const widget = widgets?.find(w => w.id === widgetId)!
        const widgetState = ws[widgetId] ?? createWidgetState()

        const scrollAmount = Math.max(1, Math.floor(widgetState.previewHeight * WIDGET_PREVIEW_SCROLL_PERCENTAGE))
        const newScroll = Math.max(
          0,
          Math.min(
            (widget.preview?.split('\n').length ?? 1) - widgetState.previewHeight,
            widgetState.previewScroll + (direction === 'up' ? scrollAmount : -scrollAmount),
          ),
        )

        return newScroll !== widgetState.previewScroll //
          ? { ...ws, [widgetId]: { ...widgetState, previewScroll: newScroll } }
          : ws
      })
    },
    [widgets],
  )

  const getWidgetState = useCallback(
    (widgetId: string) => widgetStates[widgetId] ?? createWidgetState(),
    [widgetStates],
  )

  // EFFECTS
  useLayoutEffect(() => {
    // Track size of toolbar and widgets list
    if (toolbarRef.current) setToolbarHeight(measureElement(toolbarRef.current).height)
    if (listRef.current) setWidgetsListBottomOffset(listRef.current?.getBottomOffset() ?? 0)
  }, [rows, widgetsListScroll, widgetStates])

  useEffect(() => {
    // Re-measure widgets list on resize
    const onResize = () => listRef.current?.remeasure()
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    // Clamp widget index
    setWidgetIndex(index => Math.min(Math.max(0, index), widgets ? widgets.length - 1 : 0))

    // Remove stale widget states
    setWidgetStates(ws => {
      const oldWidgetIds = Object.keys(ws)
      const newWidgetIds = widgets?.map(widget => widget.id) ?? []

      return oldWidgetIds.length !== newWidgetIds.length || oldWidgetIds.some(id => !newWidgetIds.includes(id))
        ? Object.fromEntries(Object.entries(ws).filter(([id]) => newWidgetIds.includes(id)))
        : ws
    })
  }, [widgets])

  useEffect(() => {
    // Clean up stale actions and views
    if (actionId && !action) setActionId(undefined)
    if (viewId && !view) setViewId(undefined)
  }, [actionId, viewId, action, view])

  useEffect(() => {
    // Fetch view preview every second
    if (!widget || !view) return

    const widgetId = widget.id
    const viewId = view.id

    const fetch = async () => setViewPreview(await fetchViewPreview(widgetId, viewId, columns))
    fetch()

    const intervalId = setInterval(fetch, 1000)
    return () => clearInterval(intervalId)
  }, [widget, viewId])

  useInput((input, key) => {
    if (!widget || !widgets) {
      if (input === 'q' || key.escape) {
        onExit()
      }

      return
    }

    if (action) {
      if (action.text) {
        if (key.return) {
          onAction(widget.id, action.id, actionText)

          setActionId(undefined)
          setActionText('')
        } else if (key.escape) {
          setActionId(undefined)
        }
      }

      if (action.confirm) {
        if (input === 'y') {
          onAction(widget.id, action.id)
        }

        setActionId(undefined)
      }

      return
    }

    if (view) {
      if (input === 'q' || key.escape || matchKeymaps(view.keymaps, input, key)) {
        setViewId(undefined)
      }

      return
    }

    if (input === 'k' || key.upArrow) {
      setWidgetIndex(i => (i === 0 ? widgets.length - 1 : i - 1))
    } else if (input === 'j' || key.downArrow) {
      setWidgetIndex(i => (i === widgets.length - 1 ? 0 : i + 1))
    } else if (input === 'S') {
      onSpawn()
    } else if (input === 'q' || key.escape) {
      onExit()
    } else if (input === 'u' && key.ctrl) {
      scrollWidgetPreview(widget.id, 'up')
    } else if (input === 'd' && key.ctrl) {
      scrollWidgetPreview(widget.id, 'down')
    } else if (input === '{') {
      changeWidgetPreviewHeight(widget.id, 'shrink')
    } else if (input === '}') {
      changeWidgetPreviewHeight(widget.id, 'expand')
    } else {
      const view = widget.views?.find(v => matchKeymaps(v.keymaps, input, key))
      setViewId(view?.id)

      const action = widget.actions?.find(a => matchKeymaps(a.keymaps, input, key))
      if (action?.text || action?.confirm) {
        setActionId(action.id)
      } else if (action) {
        onAction(widget.id, action.id)
      }
    }
  })

  // VIEW
  if (!widgets) {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text>Loading widgets...</Text>
      </Box>
    )
  }

  if (widgets.length === 0 || !widget) {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text>No widgets yet</Text>
      </Box>
    )
  }

  if (view) {
    return (
      <Box flexDirection="column">
        {!!viewPreview ? (
          viewPreview.split('\n').map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))
        ) : (
          <Text>Loading view...</Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {(canWidgetsListBeScrolledUp || canWidgetsListBeScrolledDown) && (
        <Box justifyContent="center">
          <Text dimColor>{canWidgetsListBeScrolledUp ? '▲ more' : ' '}</Text>
        </Box>
      )}

      {/* Widget list */}
      <ScrollList ref={listRef} selectedIndex={widgetIndex} height={widgetsListHeight} onScroll={setWidgetsListScroll}>
        {/* NOTE: Minimize dynamic height changes in list items, it makes the list flicker and jump */}

        {/* Widget */}
        {widgets.map(w => (
          <Box
            key={w.id}
            flexDirection="column"
            borderStyle={w.id === widget.id ? 'bold' : 'single'}
            borderColor={w.color}
            borderDimColor={w.id !== widget.id}
            marginX={1}
          >
            {/* Preview */}
            {getWidgetState(w.id).previewHeight > 0 && (
              <Box flexDirection="column" marginX={1}>
                <WidgetPreview
                  preview={w.preview ?? ''}
                  height={getWidgetState(w.id).previewHeight}
                  scroll={getWidgetState(w.id).previewScroll}
                  dimColor={w.id !== widget.id}
                />
              </Box>
            )}

            {/* Widget bar */}
            <Box paddingX={1}>
              {!!action?.confirm && w.id === widget.id ? (
                <>
                  <Text bold>{'› '}</Text>
                  <Text>Confirm</Text>
                  <Text> {action.name.toLowerCase()}?</Text>
                  <Text dimColor> (y/n)</Text>
                </>
              ) : !!action?.text && w.id === widget.id ? (
                <>
                  <Text color={w.color} bold>
                    {'› '}
                  </Text>
                  <Box flexGrow={1}>
                    <TextInput value={actionText} onChange={setActionText} />
                  </Box>
                </>
              ) : (
                <>
                  <Box flexShrink={0}>
                    {w.status === 'working' && (
                      <Text color={w.color}>
                        <Spinner />{' '}
                      </Text>
                    )}
                    {w.status === 'blocked' && (
                      <Text color="red">
                        <Spinner type="sand" />{' '}
                      </Text>
                    )}

                    <Text bold={w.id === widget.id} color={w.color}>
                      {w.name}
                    </Text>
                    <Text color={w.color} dimColor>
                      {' '}
                      {w.type}
                    </Text>
                  </Box>
                  <Box flexShrink={1}>
                    {w.statusline && (
                      <Text dimColor wrap="truncate-end">
                        {' '}
                        {w.statusline}
                      </Text>
                    )}
                  </Box>
                  <Spacer />
                  <Box flexShrink={1}>
                    <Text dimColor wrap="truncate-start">
                      {collapseHomedir(w.cwd)}
                    </Text>
                  </Box>
                </>
              )}
            </Box>
          </Box>
        ))}
      </ScrollList>

      {(canWidgetsListBeScrolledUp || canWidgetsListBeScrolledDown) && (
        <Box justifyContent="center">
          <Text dimColor>{canWidgetsListBeScrolledDown ? '▼ more' : ' '}</Text>
        </Box>
      )}

      {/* Toolbar */}
      <Box ref={toolbarRef} marginTop={1} marginX={2} flexDirection="column">
        {/* Actions */}
        {!!widget.actions && (
          <Text dimColor wrap="truncate-end">
            {widget.actions.map((a, i) => (
              <Fragment key={a.id}>
                {i > 0 ? ' · ' : ''}
                {formatKeymaps(a.keymaps)} to {a.name.toLowerCase()}
              </Fragment>
            ))}
            {' · { } to change height · S to spawn'}
          </Text>
        )}

        {/* Views */}
        {!!widget.views && (
          <Box>
            <Text dimColor wrap="truncate-end">
              {widget.views.map((v, i) => (
                <Fragment key={v.id}>
                  {i > 0 ? ' · ' : ''}
                  {formatKeymaps(v.keymaps)} to view {v.name.toLowerCase()}
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
  scroll: number
  dimColor?: boolean
}> = ({ preview, height, scroll, dimColor }) => {
  const lines: (string | undefined)[] = preview.split('\n').map(line => line.trimEnd())

  // Pad to fill the required height
  while (lines.length < height) {
    lines.unshift(undefined)
  }

  // Truncate lines at the end (scroll)
  const truncatedLinesEnd = []
  while (scroll > 0 && lines.length > height) {
    truncatedLinesEnd.push(lines.pop())
    scroll--
  }

  // Truncate lines at the start (doesn't fit)
  const truncatedLinesStart = []
  while (lines.length > height) {
    truncatedLinesStart.push(lines.shift())
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor={line === undefined || dimColor} wrap="truncate-end">
              {line === undefined ? '~' : line || ' '}
            </Text>
          </Box>
          {truncatedLinesStart.length > 0 && i === 0 && (
            <Box flexShrink={0}>
              <Text dimColor> {truncatedLinesStart.length}↑</Text>
            </Box>
          )}
          {truncatedLinesEnd.length > 0 && i === lines.length - 1 && (
            <Box flexShrink={0}>
              <Text dimColor> {truncatedLinesEnd.length}↓</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  )
}

// TODO: Proper matching
function matchKeymaps(keymaps: string[], input: string, key: Key) {
  return keymaps.some(
    keymap =>
      (keymap === 'Enter' && key.return) || //
      (keymap === 'Shift+Tab' && key.shift && key.tab) ||
      keymap === input,
  )
}

render(React.createElement(App), { alternateScreen: process.env.NODE_ENV !== 'dev' })

// Ensure the process always exits on signals, even if Ink's cleanup hangs.
// SIGKILL is uncatchable and the OS restores terminal settings on exit.
const forceExit = () => {
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000).unref()
  process.exit(0)
}

process.once('SIGINT', forceExit)
process.once('SIGTERM', forceExit)
