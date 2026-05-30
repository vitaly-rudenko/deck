import { homedir } from 'node:os'

export function expandHomedir(path: string) {
  return path.replace(/^~/, homedir())
}