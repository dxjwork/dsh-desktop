/**
 * Optional build helpers. When a selected source checkout has not been built
 * (no `apps/cli/lib/bin.js`), the shell can run the checkout's own install and
 * build commands so the user never has to open a terminal.
 * @module dsh-desktop/build
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Pick the package manager a checkout uses, from its lockfile. */
export function detectPackageManager(sourcePath) {
  if (existsSync(join(sourcePath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(sourcePath, 'package-lock.json'))) return 'npm'
  if (existsSync(join(sourcePath, 'yarn.lock'))) return 'yarn'
  return 'pnpm'
}

/** Whether the checkout already has an installed `node_modules`. */
export function sourceHasDependencies(sourcePath) {
  return existsSync(join(sourcePath, 'node_modules'))
}

/** Resolve the platform command for a package manager (`.cmd` on Windows). */
function commandFor(pm) {
  if (process.platform === 'win32') return `${pm}.cmd`
  return pm
}

/**
 * Quote one argument for a cmd.exe command line: wrap it in double quotes when
 * it contains whitespace or cmd metacharacters; leave plain words untouched.
 */
function quoteCmdArg(arg) {
  const text = String(arg)
  if (/^[A-Za-z0-9_./\\:-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Run a command to completion, streaming each output line to `onLine`.
 * Resolves on exit code 0, rejects on spawn failure or a non-zero exit.
 * Windows cannot spawn `.cmd`/`.bat` scripts directly (Node throws EINVAL), so
 * such commands run through `cmd.exe /d /s /c` instead.
 */
function run(command, args, cwd, onLine, env = {}) {
  return new Promise((resolve, reject) => {
    const isCmdScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
    const file = isCmdScript ? (process.env.ComSpec || 'cmd.exe') : command
    const spawnArgs = isCmdScript
      ? ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')]
      : args
    const child = spawn(file, spawnArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdoutBuffer = ''
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '')
        if (trimmed.length > 0) onLine?.(trimmed)
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) onLine?.(line)
      }
    })

    child.once('error', (error) => reject(error))
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`命令 "${command} ${args.join(' ')}" 退出码 ${String(code)}`))
    })
  })
}

/** Install the checkout's dependencies with its own package manager. */
export function installDependencies(sourcePath, onLine) {
  const pm = detectPackageManager(sourcePath)
  const env = {}
  if (pm === 'pnpm') {
    // pnpm sometimes decides node_modules must be removed and re-created (the
    // checkout moved, or the lockfile changed since the last install). Without
    // a TTY it then aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    // instead of asking, so tell it to proceed non-interactively.
    env.npm_config_confirm_modules_purge = 'false'
  }
  return run(commandFor(pm), ['install'], sourcePath, onLine, env)
}

/** Build the checkout (`<pm> run build`), which produces the dsh CLI bundle. */
export function buildSource(sourcePath, onLine) {
  const pm = detectPackageManager(sourcePath)
  return run(commandFor(pm), ['run', 'build'], sourcePath, onLine)
}
