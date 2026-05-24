import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import * as os from 'node:os'

interface MenuItem {
  id: string
  title: string
  separator?: boolean
  children?: MenuItem[]
}

type SwiftbarMenubarEvent =
  | { type: 'click'; data: { id: string } } //
  | { type: 'failure'; data: { message: string } }

export class SwiftbarMenubar {
  #emitter = new EventEmitter()
  #options

  #startPromise: Promise<void> | undefined
  #server: Server | undefined

  #items: MenuItem[] = []
  #icon: string

  constructor(options: { swiftbarPluginsDir: string; port: number; defaultIcon: string }) {
    this.#options = options
    this.#icon = this.#options.defaultIcon
  }

  on<E extends SwiftbarMenubarEvent | { type: 'menubar_event'; data: SwiftbarMenubarEvent }, T extends E['type']>(
    type: T,
    handler: (data: Extract<E, { type: T; data: object }>['data']) => void,
  ): void {
    this.#emitter.on(type, handler)
  }

  async update(state: { icon: string; children: MenuItem[] }): Promise<void> {
    this.#icon = state.icon
    this.#items = state.children

    await (this.#startPromise ??= this.#start())
  }

  async dispose(): Promise<void> {
    this.#emitter.removeAllListeners()

    await this.#startPromise?.catch(() => {})
    this.#server?.close()
    this.#server?.closeAllConnections()
    this.#server = undefined
  }

  // ---

  async #start(): Promise<void> {
    return new Promise(async resolve => {
      const swiftbarPluginsDir = path.resolve(this.#options.swiftbarPluginsDir.replace('~/', os.homedir()))
      await mkdir(swiftbarPluginsDir, { recursive: true })

      const server = createServer((req, res) => {
        if (req.url === '/menu') {
          const lines = [this.#icon, '---']

          for (const item of this.#items) {
            this.#renderInto(lines, item)
          }

          res.end(lines.join('\n') + '\n')
        } else if (req.url?.startsWith('/click/')) {
          this.#emit('click', { id: decodeURIComponent(req.url.slice('/click/'.length)) })

          res.end('ok')
        } else {
          res.writeHead(404).end()
        }
      })

      server.listen(this.#options.port, '127.0.0.1', async () => {
        this.#server = server

        const scriptPath = path.join(swiftbarPluginsDir, 'deck.1s.sh')
        await writeFile(
          scriptPath,
          [
            '#!/bin/sh',
            `curl -s http://127.0.0.1:${this.#options.port}/menu 2>/dev/null || printf '${this.#options.defaultIcon}`,
            '---',
            `Quit | bash=/bin/rm param1=${scriptPath} terminal=false`,
            "'",
          ].join('\n') + '\n',
          { mode: 0o755 },
        )

        resolve()
      })
    })
  }

  #renderInto(lines: string[], item: MenuItem, indent = '') {
    if (item.separator) {
      lines.push(indent + '---')
      return
    }

    const title = indent + item.title
    const url = `http://127.0.0.1:${this.#options.port}/click/${encodeURIComponent(item.id)}`
    lines.push(`${title} | bash=/usr/bin/curl param1=-s param2=-X param3=POST param4=${url} terminal=false`)

    if (item.children && item.children.length > 0) {
      for (const child of item.children) {
        this.#renderInto(lines, child, indent + '--')
      }
    }
  }

  #emit<T extends SwiftbarMenubarEvent['type']>(
    type: T,
    data: Extract<SwiftbarMenubarEvent, { type: T; data: object }>['data'],
  ): void {
    this.#emitter.emit(type, data)
    this.#emitter.emit('menubar_event', { type, data })
  }
}
