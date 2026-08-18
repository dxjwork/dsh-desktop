/**
 * Validation and resolution against a DeepSeek Harness source checkout.
 * The shell never bundles the harness; it locates the built `dsh` CLI inside
 * a user-selected source directory instead.
 * @module dsh-desktop/source
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_MANIFEST = 'package.json'
const CLI_BIN = join('apps', 'cli', 'lib', 'bin.js')
const CLI_SOURCE = join('apps', 'cli', 'src', 'bin.ts')
const WEB_DIST_INDEX = join('apps', 'web', 'dist', 'index.html')

/**
 * Absolute path of the built dsh CLI bundle, or `undefined` when the checkout
 * has not been built yet.
 * @param {string} sourcePath - root of the DeepSeek Harness checkout.
 */
export function resolveDshBin(sourcePath) {
  const bin = join(sourcePath, CLI_BIN)
  return existsSync(bin) ? bin : undefined
}

/**
 * Whether a checkout is fully built. `dsh web` needs both the CLI bundle and
 * the web frontend dist (it refuses to boot without `apps/web/dist`), so the
 * CLI alone is not enough for the shell to start.
 * @param {string} sourcePath - root of the DeepSeek Harness checkout.
 */
export function sourceIsBuilt(sourcePath) {
  return resolveDshBin(sourcePath) !== undefined && existsSync(join(sourcePath, WEB_DIST_INDEX))
}

/**
 * Check that a directory plausibly is a DeepSeek Harness checkout.
 * @param {string|undefined} sourcePath - candidate directory.
 * @returns {{ ok: boolean, reason: string }}
 */
export function validateSourcePath(sourcePath) {
  if (!sourcePath) {
    return { ok: false, reason: '未选择源码目录。' }
  }
  if (!existsSync(join(sourcePath, ROOT_MANIFEST))) {
    return { ok: false, reason: '所选目录缺少 package.json，不是 DeepSeek Harness 仓库根目录。' }
  }
  if (existsSync(join(sourcePath, CLI_BIN)) || existsSync(join(sourcePath, CLI_SOURCE))) {
    return { ok: true, reason: '' }
  }
  return { ok: false, reason: '所选目录缺少 apps/cli（dsh 命令行工具），不是有效的 DeepSeek Harness 源码。' }
}
