import TextInput from 'ink-text-input'
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { render, Box, Text, useApp, useInput, Key, useStdout } from 'ink'

import { collapseHomedir } from './utils/collapse-homedir.ts'
import { formatTimeAgo } from './utils/format-time-ago.ts'
import { TmuxProvider } from './tmux-provider.ts'
import type { Widget } from './widget.ts'
import type { Provider } from './provider.ts'
import { SwiftbarMenubar } from './integrations/swiftbar-menubar.ts'

const terminalAppName = process.env.DECK_TERMINAL_APP_NAME
const swiftbarPluginsDir = process.env.DECK_SWIFTBAR_PLUGINS_DIR
const port = process.env.DECK_SWIFTBAR_PORT ? Number(process.env.DECK_SWIFTBAR_PORT) : undefined
const shortcut = process.env.DECK_SHORTCUT

const providers: Provider[] = [new TmuxProvider({ terminalAppName, shortcut })]

const typeLabelMap: Record<string, string> = {
  pi: 'Pi',
  claude_code: 'Claude',
}

function getWidgetName(widget: Widget) {
  const type = typeLabelMap[widget.type] ?? widget.type
  return widget.name ? `${type}: ${widget.name}` : type
}

const App: React.FC = () => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [widgets, setWidgets] = useState<Widget[]>()
  const [width, setWidth] = useState(() => stdout.columns)
  const [height, setHeight] = useState(() => stdout.rows)

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

    stdout.on('resize', onResize)
    function onResize() {
      setWidth(stdout.columns)
      setHeight(stdout.rows)
    }

    return () => {
      clearInterval(intervalId)
      stdout.off('resize', onResize)
    }
  }, [])

  return (
    <>
      <Dashboard
        width={width}
        height={height}
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
  width: number
  height: number

  widgets: Widget[] | undefined
  view: (widgetId: string, viewId: string, height: number) => Promise<string>
  onAction: (widgetId: string, actionId: string, text?: string) => Promise<void>
  onExit: () => void
}> = ({ height, widgets, view: getView, onAction, onExit }) => {
  const [now, setNow] = useState(() => Date.now())
  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [textActionId, setTextActionId] = useState<string>()
  const [confirmActionId, setConfirmActionId] = useState<string>()
  const [viewId, setViewId] = useState<string>()
  const [view, setView] = useState<string>()

  const widget = useMemo(() => widgets?.[index], [widgets, index])
  const shouldShowNames = useMemo(
    () => widgets?.some(w1 => w1.name || widgets?.some(w2 => w1.type !== w2.type)),
    [widgets],
  )

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
      setView(await getView(widget!.id, viewId!, height))
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
        if (text) {
          onAction(widget.id, textActionId, text)
        }

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
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Box flexDirection="column" flexShrink={0} maxWidth={4}>
          <Text dimColor wrap="truncate">
            {'  '}#
          </Text>
          {widgets.map((widget, j) => (
            <Text key={widget.id} wrap="truncate-middle">
              {j === index ? '› ' : '  '}
              {j + 1}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={0} maxWidth={40}>
          <Text dimColor wrap="truncate">
            {' '}
            Directory
          </Text>
          {widgets.map((widget, j) => (
            <Text key={widget.id} wrap="truncate-middle">
              {' '}
              {collapseHomedir(widget.cwd)}
            </Text>
          ))}
        </Box>
        {shouldShowNames && (
          <Box flexDirection="column" flexShrink={0} maxWidth={30}>
            <Text dimColor wrap="truncate-end">
              {' '}
              │ Name
            </Text>
            {widgets.map(widget => (
              <Text key={widget.id} wrap="truncate-end">
                {' '}
                │ {shouldShowNames ? getWidgetName(widget) : ''}
                {widget.name}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {' '}
            │ Status
          </Text>
          {widgets.map(widget => (
            <Text key={widget.id} wrap="truncate-end">
              {' '}
              │ {widget.status}, {formatTimeAgo(widget.lastUpdatedAt?.getTime(), now)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {' '}
            │ Preview
          </Text>
          {widgets.map(widget => (
            <Text key={widget.id} wrap="truncate-end" italic>
              {' '}
              │ {widget.preview?.trim() ?? 'No preview'}
            </Text>
          ))}
        </Box>
      </Box>

      <Box marginTop={1}>
        {!!confirmActionId && (
          <Box marginLeft={2}>
            <Text>Confirm? (y/n)</Text>
          </Box>
        )}

        {!!textActionId && (
          <Box flexDirection="column">
            <Box>
              <Text>{'› '}</Text>
              <TextInput value={text} onChange={setText} />
            </Box>
            <Box marginLeft={2}>
              <Text>enter to submit · escape to cancel</Text>
            </Box>
          </Box>
        )}

        {!textActionId && !confirmActionId && (
          <Box flexDirection="column" marginLeft={2}>
            {!!widget.actions && (
              <Box>
                {widget.actions.map((action, i) => (
                  <Text key={action.id}>
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
                  <Text key={view.id}>
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
  )
}

function matchKeymap(keymap: string, input: string, key: Key) {
  return (keymap === 'Enter' && key.return) || keymap === input
}

render(React.createElement(App))
