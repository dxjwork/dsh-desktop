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
 * Run a command to completion, streaming each output line to `onLine`.
 * Resolves on exit code 0, rejects on spawn failure or a non-zero exit.
 */
function run(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
  return run(commandFor(pm), ['install'], sourcePath, onLine)
}

/** Build the checkout (`<pm> run build`), which produces the dsh CLI bundle. */
export function buildSource(sourcePath, onLine) {
  const pm = detectPackageManager(sourcePath)
  return run(commandFor(pm), ['run', 'build'], sourcePath, onLine)
}
