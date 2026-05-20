import os from "os";

const homedir = os.homedir();

export function collapseHomedir(path: string) {
  return path.replace(homedir + '/', '~/');
}
