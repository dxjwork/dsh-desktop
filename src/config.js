/**
 * Persisted client configuration, stored as JSON in Electron's per-user
 * `userData` directory. The only durable value today is the path to the
 * DeepSeek Harness source checkout the shell should boot.
 * @module dsh-desktop/config
 */

import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_FILE = 'config.json'

/** Absolute path of the on-disk config file. */
export function configFilePath() {
  return join(app.getPath('userData'), CONFIG_FILE)
}

/** Read the config, returning `{}` when it is absent or unreadable. */
export function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configFilePath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write the config, creating the userData directory as needed. */
export function saveConfig(config) {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** The configured harness source path, or `undefined` when unset. */
export function getHarnessSourcePath(config) {
  const value = config && config.harnessSourcePath
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Return a shallow copy of the config with the source path replaced. */
export function setHarnessSourcePath(config, sourcePath) {
  return { ...(config ?? {}), harnessSourcePath: sourcePath }
}
