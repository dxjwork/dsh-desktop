/**
 * DeepSeek account-balance service for the desktop shell's own status bar.
 * Re-implements the web GUI's host billing capability in plain JavaScript:
 * resolve the provider API key and base URL, query `GET {base}/user/balance`,
 * and cache the answer for a minute. It is a display reference only, never a
 * billing or gating input.
 * @module dsh-desktop/billing
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_BASE_URL = 'https://api.deepseek.com'
const API_KEY_ENV = 'DEEPSEEK_API_KEY'
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const CACHE_TTL_MS = 60_000
const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * One best-effort balance fetch; every failure folds to `undefined`.
 * Pure over an injected fetch so the wire can be reasoned about without a
 * running Electron context.
 * @param {{ apiKey?: string, baseUrl: string }} resolve
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string}> | undefined>}
 */
export async function queryBalance(resolve, fetchImpl = fetch) {
  if (!resolve.apiKey) return undefined
  try {
    const response = await fetchImpl(`${resolve.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${resolve.apiKey}` },
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (!Array.isArray(payload.balance_infos)) return undefined
    return payload.balance_infos.map((row) => ({
      currency: String(row.currency ?? ''),
      totalBalance: String(row.total_balance ?? '0'),
      grantedBalance: String(row.granted_balance ?? '0'),
      toppedUpBalance: String(row.topped_up_balance ?? '0'),
    }))
  } catch {
    return undefined
  }
}

/**
 * Resolve the harness home the spawned `dsh web` uses: `$DSH_HOME` when set,
 * else `~/.dsh`. This is where the web GUI's Models page persists credentials.
 * @returns {string}
 */
export function resolveDshHome() {
  const explicit = process.env.DSH_HOME
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : join(homedir(), '.dsh')
}

/**
 * Read one credential reference from the harness's managed credentials store
 * (`<dsh home>/.credentials.yaml`), matching what the web service resolves for
 * `credentialRef('DEEPSEEK_API_KEY')`. The document is a flat `KEY: value`
 * YAML mapping, so a hand parser suffices; every failure folds to `undefined`.
 * @param {string} ref - the credential reference name (e.g. `DEEPSEEK_API_KEY`).
 * @returns {string | undefined}
 */
export function readManagedCredential(ref) {
  try {
    const filename = join(resolveDshHome(), CREDENTIALS_FILENAME)
    if (!existsSync(filename)) return undefined
    const value = parseCredentialsYaml(readFileSync(filename, 'utf8'))[ref]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Parse the credentials document's flat `KEY: value` mapping. */
function parseCredentialsYaml(text) {
  const map = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (key !== '') map[key] = value
  }
  return map
}

/**
 * Cached balance service. `config` is the desktop client's persisted config.
 * The API key resolves: `config.deepseekApiKey` → the harness web service's own
 * managed credential (`<dsh home>/.credentials.yaml`) → `DEEPSEEK_API_KEY`
 * environment. The base URL resolves: `config.deepseekBaseUrl` →
 * `DEEPSEEK_BASE_URL` environment → the public DeepSeek API.
 */
export class BillingService {
  /** @param {object} [config] */
  constructor(config = {}) {
    this.config = config
    /** @type {{ at: number, rows: Array<object> } | undefined} */
    this.cached = undefined
  }

  resolveApiKey() {
    const explicit = this.config.deepseekApiKey
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const managed = readManagedCredential(API_KEY_ENV)
    if (managed !== undefined) return managed
    const env = process.env[API_KEY_ENV]
    return typeof env === 'string' && env.length > 0 ? env : undefined
  }

  resolveBaseUrl() {
    const base = this.config.deepseekBaseUrl ?? process.env[BASE_URL_ENV]
    return typeof base === 'string' && base.length > 0 ? base : PUBLIC_BASE_URL
  }

  /** Current balance rows, cached for {@link CACHE_TTL_MS}. */
  async getBalance() {
    if (this.cached !== undefined && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.rows
    const rows = await queryBalance({ apiKey: this.resolveApiKey(), baseUrl: this.resolveBaseUrl() })
    this.cached = rows === undefined ? undefined : { at: Date.now(), rows }
    return rows
  }

  /** Balance as an overlay-friendly state object (never throws). */
  async getState() {
    const rows = await this.getBalance()
    return rows !== undefined && rows.length > 0
      ? { status: 'ready', rows }
      : { status: 'unavailable' }
  }

  /** Drop the cache and re-query (the status bar's manual refresh). */
  async refresh() {
    this.cached = undefined
    return this.getState()
  }
}
