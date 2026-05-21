import os from 'os'

const homedir = os.homedir()

export function collapseHomedir(path: string) {
  if (path === homedir) return 'home'
  return path.replace(homedir + '/', '')
}
