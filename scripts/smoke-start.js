/**
 * Headless smoke test for the harness-start logic, run without Electron. It
 * resolves the built dsh CLI in a source checkout, spawns `dsh web --port 0`,
 * waits for the readiness line, prints the URL, then stops the child.
 *
 * Usage:
 *   node scripts/smoke-start.js <path-to-harness-checkout>
 *   DSH_SOURCE_PATH=<path> node scripts/smoke-start.js
 *
 * @module dsh-desktop/scripts/smoke-start
 */

import { resolve } from 'node:path'
import { startHarness, buildHarnessArgs } from '../src/harness.js'
import { resolveDshBin, validateSourcePath } from '../src/source.js'

const rawSource = process.argv[2] ?? process.env.DSH_SOURCE_PATH
if (rawSource === undefined || rawSource === '') {
  console.error('[smoke] 用法: node scripts/smoke-start.js <harness源码目录>（或设置 DSH_SOURCE_PATH）')
  process.exit(1)
}
const sourcePath = resolve(rawSource)

const validation = validateSourcePath(sourcePath)
if (!validation.ok) {
  console.error(`[smoke] 无效源码目录: ${validation.reason}`)
  process.exit(1)
}

const bin = resolveDshBin(sourcePath)
if (!bin) {
  console.error('[smoke] 源码尚未构建（缺少 apps/cli/lib/bin.js），请先在源码目录运行 pnpm run build')
  process.exit(1)
}

console.log(`[smoke] 源码目录: ${sourcePath}`)
console.log(`[smoke] dsh bin:   ${bin}`)

const handle = await startHarness({
  nodeExecutable: 'node',
  dshBin: bin,
  cwd: sourcePath,
  args: buildHarnessArgs(0),
  onOutput: (line) => console.log(`[harness] ${line}`),
  onError: (chunk) => console.error(`[harness:err] ${chunk.trimEnd()}`),
})

console.log(`[smoke] READY ${handle.url}`)
await handle.stop()
console.log('[smoke] 已停止 web 服务。')
process.exit(0)
