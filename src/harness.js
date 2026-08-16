/**
 * Child-process harness management, mirroring the official desktop launcher:
 * spawn `node <apps/cli/lib/bin.js> web --port 0`, then treat the `dsh web:
 * http://127.0.0.1:<port>` readiness line as the signal to open a window.
 * @module dsh-desktop/harness
 */

import { spawn } from 'node:child_process'

/** The loopback readiness line the web profile prints once its server binds. */
const READY_URL_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/
/** Grace allowed for the child to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 3_000
/** Ceiling on waiting for the readiness line before a start is failed. */
const READY_TIMEOUT_MS = 30_000

/** The dsh invocation the shell uses: the web profile on an OS-assigned port. */
export function buildHarnessArgs(port = 0) {
  return ['web', '--port', String(port)]
}

/**
 * Extract the loopback URL from a harness stdout line.
 * @param {string} line - one line of the harness stdout.
 * @returns {string|undefined} the `http://127.0.0.1:<port>` URL, if present.
 */
export function parseReadyUrl(line) {
  const match = READY_URL_PATTERN.exec(String(line ?? '').trimStart())
  return match ? match[1] : undefined
}

/**
 * Spawn the harness and resolve once it prints its readiness line.
 * @param {object} options
 * @param {string} options.nodeExecutable - node binary (typically `'node'`).
 * @param {string} options.dshBin - absolute path to the built dsh CLI bundle.
 * @param {string} options.cwd - working directory (the source checkout root).
 * @param {readonly string[]} [options.args] - args after the bin path.
 * @param {Record<string, string>} [options.env] - extra environment entries.
 * @param {(line: string) => void} [options.onOutput] - stdout line sink.
 * @param {(chunk: string) => void} [options.onError] - stderr chunk sink.
 * @returns {Promise<{url: string, exited: Promise<{code: number|null, signal: string|null}>, stop: () => Promise<void>}>}
 */
export function startHarness(options) {
  const args = options.args ?? buildHarnessArgs(0)
  const child = spawn(options.nodeExecutable, [options.dshBin, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdout === null || stderr === null) {
    child.kill()
    return Promise.reject(new Error('未能接管 web 服务的输出管道。'))
  }

  const onOutput = options.onOutput ?? ((line) => { process.stdout.write(`${line}\n`) })
  const onError = options.onError ?? ((chunk) => { process.stderr.write(chunk) })

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        exited.then(() => undefined),
        new Promise((resolve) => {
          setTimeout(() => { child.kill('SIGKILL'); resolve() }, STOP_GRACE_MS)
        }),
      ])
    }
  }

  const ready = new Promise((resolve, reject) => {
    let settled = false
    const settle = (url) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      resolve(url)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      reject(error)
    }
    const readyTimer = setTimeout(() => {
      fail(new Error(`web 服务在 ${String(READY_TIMEOUT_MS)}ms 内未就绪。`))
      child.kill('SIGKILL')
    }, READY_TIMEOUT_MS)

    const stderrChunks = []
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk) => {
      stderrChunks.push(chunk)
      onError(chunk)
    })

    let stdoutBuffer = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        onOutput(line)
        if (settled) continue
        const url = parseReadyUrl(line)
        if (url !== undefined) settle(url)
      }
    })

    child.once('exit', (code, signal) => {
      const suffix = stderrChunks.join('').trim()
      fail(new Error(
        `web 服务在就绪前退出（code ${String(code)}, signal ${String(signal)})`
        + `${suffix === '' ? '' : `：${suffix}`}`,
      ))
    })
    child.once('error', (error) => {
      fail(new Error(`无法启动 web 服务（${error.message}）。请确认 Node 已安装且源码已构建。`))
    })
  })

  return ready.then((url) => ({ url, exited, stop }))
}
