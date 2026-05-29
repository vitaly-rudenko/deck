import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

const logPath = '/tmp/deck/latest.log'

mkdirSync(dirname(logPath), { recursive: true })
writeFileSync(logPath, '')

function timestamp() {
  return `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] `
}

console.log = (...args) => appendFileSync(logPath, timestamp() + format(...args) + '\n')
console.warn = (...args) => appendFileSync(logPath, timestamp() + '[WARN] ' + format(...args) + '\n')
console.error = (...args) => appendFileSync(logPath, timestamp() + '[ERR] ' + format(...args) + '\n')

console.log('Initialized')
