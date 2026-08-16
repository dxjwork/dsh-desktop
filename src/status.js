/**
 * Main-process status service: polls the spawned harness's RPC surface
 * (`session.list`, `subagent.list`, and the `/api/events.mux` SSE stream) plus
 * the DeepSeek balance endpoint, and folds them into one render-ready object
 * for the title-bar view. It lives in the main process so the title bar never
 * has to cross origins (the harness serves no CORS).
 * @module dsh-desktop/status
 */

import { randomUUID } from 'node:crypto'

const REFRESH_MS = 5000
const RATE_WINDOW_MS = 15000

/** One unary RPC against the harness gateway. */
async function rpc(baseUrl, method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: payload ?? {} }),
  })
  return response.json()
}

/** Sum the four provider-reported buckets of one usage object. */
function totalTokensOf(usage) {
  if (usage === undefined) return 0
  return (usage.uncachedInputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

export class StatusService {
  constructor(baseUrl, billing) {
    this.baseUrl = baseUrl
    this.billing = billing
    this.sessions = []
    this.jobsBySession = new Map()
    this.subagents = []
    this.tokenSamples = []
    this.rate = undefined
    this.stopped = false
    this.timer = undefined
    this.abort = undefined
  }

  tokenUsageOf(session) {
    return session?.projections?.values?.tokenUsage
  }

  sumField(field) {
    let total = 0
    for (const session of this.sessions) {
      const usage = this.tokenUsageOf(session)
      if (usage !== undefined) total += usage[field] ?? 0
    }
    return total
  }

  totalTokens() {
    let total = 0
    for (const session of this.sessions) total += totalTokensOf(this.tokenUsageOf(session))
    return total
  }

  currentSession() {
    if (this.sessions.length === 0) return undefined
    const running = this.sessions.filter((s) => s.running)
    const pool = running.length > 0 ? running : this.sessions
    return pool.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a))
  }

  currentUsage() {
    return this.tokenUsageOf(this.currentSession())
  }

  cacheReadTokens() {
    return this.sumField('cacheReadTokens')
  }

  cacheHitRatio() {
    const input = this.sumField('uncachedInputTokens') + this.sumField('cacheReadTokens') + this.sumField('cacheWriteTokens')
    return input <= 0 ? undefined : this.cacheReadTokens() / input
  }

  liveJobs() {
    const rows = []
    for (const jobs of this.jobsBySession.values()) {
      for (const job of jobs) {
        if (job.status === 'running' || job.status === 'stopping') rows.push(job)
      }
    }
    return rows
  }

  async refreshSessions() {
    try {
      const response = await rpc(this.baseUrl, 'session.list', {})
      if (!response?.result?.ok) return
      this.sessions = response.result.value.items ?? []

      // Subagents only run under a live parent session; poll just those.
      const found = []
      const runningIds = this.sessions.filter((s) => s.running).map((s) => s.sessionId)
      await Promise.all(runningIds.map(async (parentSessionId) => {
        const sub = await rpc(this.baseUrl, 'subagent.list', { parentSessionId })
        if (!sub?.result?.ok) return
        for (const entry of sub.result.value.entries ?? []) {
          if (entry.kind === 'child' && entry.activity === 'running') {
            found.push({ id: entry.id, label: entry.label || '未命名子代理' })
          }
        }
      }))
      this.subagents = found

      // Rolling consumption rate over the last window of cumulative totals.
      const t = Date.now()
      this.tokenSamples.push({ t, total: this.totalTokens() })
      const cutoff = t - RATE_WINDOW_MS
      while (this.tokenSamples.length > 1 && this.tokenSamples[0].t < cutoff) this.tokenSamples.shift()
      const first = this.tokenSamples[0]
      const last = this.tokenSamples[this.tokenSamples.length - 1]
      const dt = (last.t - first.t) / 1000
      this.rate = dt > 0 ? (last.total - first.total) / dt : undefined
    } catch {
      // A single failed poll must not stop the service.
    }
  }

  /** Consume the /api/events.mux SSE stream for `session/jobs` frames. */
  async connectJobStream() {
    this.abort = new AbortController()
    const response = await fetch(`${this.baseUrl}/api/events.mux`, {
      headers: { accept: 'text/event-stream' },
      signal: this.abort.signal,
    })
    if (!response.ok || response.body === null) throw new Error(`events.mux: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const frame = JSON.parse(line.slice(6))
            if (frame?.type === 'server-request' && frame.method === 'session/jobs') {
              this.jobsBySession.set(frame.payload.sessionId, frame.payload.jobs ?? [])
            }
          } catch { /* ignore malformed frame */ }
        }
      }
    }
  }

  async runJobStream() {
    for (;;) {
      if (this.stopped) return
      try {
        await this.connectJobStream()
      } catch { /* stream ended or failed; reconnect after a beat */ }
      if (this.stopped) return
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }

  start() {
    void this.refreshSessions()
    this.timer = setInterval(() => { void this.refreshSessions() }, REFRESH_MS)
    void this.runJobStream()
  }

  stop() {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.abort?.abort()
  }

  /** Force a fresh poll of sessions/subagents plus a balance re-query. */
  async refresh() {
    await Promise.all([
      this.refreshSessions(),
      this.billing.refresh(),
    ])
  }

  /** Combined render-ready status (never throws). */
  async getStatus() {
    const balance = await this.billing.getState()
    return {
      balance,
      tokens: {
        total: this.totalTokens(),
        current: totalTokensOf(this.currentUsage()),
        cacheRead: this.cacheReadTokens(),
        cacheRatio: this.cacheHitRatio(),
        rate: this.rate,
      },
      jobs: this.liveJobs().map((job) => ({
        id: job.id,
        label: job.label ?? job.kind ?? job.id,
        startedAt: job.startedAt ?? Date.now(),
      })),
      subagents: this.subagents,
    }
  }
}
