/**
 * Electron main entry for the desktop shell. On first launch it asks the user
 * to pick a DeepSeek Harness source checkout, then boots that checkout's
 * `dsh web` as a child process, waits for its readiness line, and opens one
 * native window over the served GUI. Account balance and session activity are
 * rendered in a separate status bar docked below the window, so nothing
 * overlays the web page.
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BillingService } from './billing.js'
import { buildSource, detectPackageManager, installDependencies, sourceHasDependencies } from './build.js'
import { getHarnessSourcePath, loadConfig, saveConfig, setHarnessSourcePath } from './config.js'
import { buildHarnessArgs, startHarness } from './harness.js'
import { resolveDshBin, validateSourcePath } from './source.js'
import { StatusService } from './status.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATUS_PANEL_WIDTH = 620
const STATUS_PANEL_HEIGHT = 34
const LOADING_HTML = join(__dirname, '..', 'renderer', 'loading.html')
const SETTINGS_HTML = join(__dirname, '..', 'renderer', 'settings.html')
const SETTINGS_PRELOAD = join(__dirname, 'settings-preload.cjs')
const STATUS_HTML = join(__dirname, '..', 'renderer', 'status.html')
const STATUS_PRELOAD = join(__dirname, 'status-preload.cjs')

/** The running harness, undefined before boot resolves or after a failure. */
let harness
/** Desktop-side DeepSeek balance service (recreated whenever the config reloads). */
let billing
/** True once quitting has begun, so the stop-and-quit path cannot re-enter. */
let quitting = false
let loadingWindow = null
let mainWindow = null
let settingsWindow = null
let statusService = null
let statusTimer = null
let statusPanel = null
/** Latest computed status, kept for the details dialog. */
let statusSnapshot = null

/** Whether two URLs share an origin, for routing external links out of the app. */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

// ── formatting (shared by the details dialog) ──
function scaled(v) { return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10) }
function fmtTokens(n) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1_000_000)}M`
}
function fmtRate(tps) {
  if (tps === undefined) return '–'
  if (tps >= 1) return `${scaled(tps)} tok/s`
  return `${scaled(tps * 60)} tok/min`
}
function fmtSymbol(code) { return { CNY: '¥', USD: '$', EUR: '€' }[code] ?? `${code} ` }
function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Push a status line into the loading window (no-op once it is closed). */
function setStatus(text) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)})`).catch(() => {})
  }
}

/** Show (or update) the small loading window used during boot and build. */
function showLoading(message) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    setStatus(message)
    return
  }
  loadingWindow = new BrowserWindow({
    width: 480,
    height: 220,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'DeepSeek Harness',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  loadingWindow.once('ready-to-show', () => {
    setStatus(message)
    loadingWindow.show()
  })
  loadingWindow.on('closed', () => { loadingWindow = null })
  loadingWindow.loadFile(LOADING_HTML)
}

function closeLoading() {
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close()
  loadingWindow = null
}

/**
 * Create the native window over the ready harness URL, plus the status bar
 * docked below it. In-app popups stay in the window; cross-origin targets open
 * in the system browser.
 */
function createMainWindow(harnessUrl) {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DeepSeek Harness',
    autoHideMenuBar: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, harnessUrl)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, harnessUrl)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  window.on('closed', () => {
    mainWindow = null
    stopStatusPush()
    closeStatusPanel()
  })
  void window.loadURL(harnessUrl)
  createStatusPanel(window)
  return window
}

/** Create the frameless status pill docked just below the main window's right edge. */
function createStatusPanel(parent) {
  const bounds = parent.getBounds()
  statusPanel = new BrowserWindow({
    width: STATUS_PANEL_WIDTH,
    height: STATUS_PANEL_HEIGHT,
    x: bounds.x + bounds.width - STATUS_PANEL_WIDTH - 8,
    y: bounds.y + bounds.height + 6,
    frame: false,
    transparent: true,
    parent,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: STATUS_PRELOAD },
  })
  statusPanel.once('ready-to-show', () => {
    syncStatusPanel()
    statusPanel.showInactive()
  })
  statusPanel.loadFile(STATUS_HTML)
  parent.on('move', syncStatusPanel)
  parent.on('resize', syncStatusPanel)
  parent.on('minimize', () => { statusPanel?.hide() })
  parent.on('restore', () => { statusPanel?.showInactive() })
}

function closeStatusPanel() {
  if (statusPanel && !statusPanel.isDestroyed()) statusPanel.close()
  statusPanel = null
}

function syncStatusPanel() {
  if (mainWindow === null || mainWindow.isDestroyed() || statusPanel === null || statusPanel.isDestroyed()) return
  const bounds = mainWindow.getBounds()
  statusPanel.setPosition(bounds.x + bounds.width - STATUS_PANEL_WIDTH - 8, bounds.y + bounds.height + 6)
}

/** Pull the latest status and push it into the status bar. */
async function pushStatus() {
  if (statusService === null || statusPanel === null || statusPanel.isDestroyed()) return
  try {
    statusSnapshot = await statusService.getStatus()
    if (statusPanel.isDestroyed()) return
    await statusPanel.webContents
      .executeJavaScript(`window.__renderStatus && window.__renderStatus(${JSON.stringify(statusSnapshot)})`)
      .catch(() => {})
  } catch {
    // A single failed status refresh must not disturb the app.
  }
}

function startStatusPush() {
  if (statusTimer !== null) return
  statusTimer = setInterval(() => { void pushStatus() }, 2000)
}

function stopStatusPush() {
  if (statusTimer !== null) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

/** Show the full status breakdown in a native dialog. */
function showStatusDetails() {
  const status = statusSnapshot
  if (status === null) return
  const t = status.tokens ?? {}
  const bal = status.balance
  const lines = []

  if (bal && bal.status === 'ready' && bal.rows && bal.rows.length) {
    for (const row of bal.rows) {
      lines.push(`余额：${row.currency} 总额 ${row.totalBalance}（充值 ${row.toppedUpBalance} / 赠送 ${row.grantedBalance}）`)
    }
  } else {
    lines.push('余额：不可用')
  }
  lines.push('')
  lines.push(`Token 总消耗：${fmtTokens(t.total ?? 0)}`)
  lines.push(`Token 当前会话：${fmtTokens(t.current ?? 0)}`)
  const ratio = t.cacheRatio === undefined ? '' : ` · ${Math.round(t.cacheRatio * 100)}%`
  lines.push(`缓存命中：${fmtTokens(t.cacheRead ?? 0)}${ratio}`)
  lines.push(`消耗速率：${fmtRate(t.rate)}`)

  const jobs = status.jobs ?? []
  if (jobs.length) {
    lines.push('')
    lines.push('运行中的任务：')
    for (const job of jobs) lines.push(`  • ${job.label}（${fmtElapsed(Date.now() - (job.startedAt ?? Date.now()))}）`)
  }
  const subs = status.subagents ?? []
  if (subs.length) {
    lines.push('')
    lines.push('运行中的子代理：')
    for (const sub of subs) lines.push(`  • ${sub.label}`)
  }

  void dialog.showMessageBox({
    type: 'info',
    title: 'DeepSeek Harness 状态',
    message: '状态',
    detail: lines.join('\n'),
  })
}

/** Open (or focus) the settings window that edits the persisted config. */
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '设置',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: SETTINGS_PRELOAD,
    },
  })
  settingsWindow.on('closed', () => { settingsWindow = null })
  settingsWindow.loadFile(SETTINGS_HTML)
}

/** Register the settings/status IPC surface (called once at startup). */
function registerIpcHandlers() {
  ipcMain.handle('status:refresh', async () => {
    if (statusService === null) return { ok: false }
    await statusService.refresh()
    void pushStatus()
    return { ok: true }
  })

  ipcMain.handle('status:details', () => { showStatusDetails() })

  ipcMain.handle('settings:get', () => loadConfig())

  ipcMain.handle('settings:pickDirectory', async (_event, current) => {
    const result = await dialog.showOpenDialog({
      title: '选择 DeepSeek Harness 源码目录',
      defaultPath: typeof current === 'string' ? current : undefined,
      buttonLabel: '使用此目录',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })

  ipcMain.handle('settings:save', async (_event, patch) => {
    try {
      const config = loadConfig()
      const sourcePath = typeof patch?.harnessSourcePath === 'string' ? patch.harnessSourcePath.trim() : ''
      if (sourcePath === '') return { ok: false, error: '源码目录不能为空。' }
      const validation = validateSourcePath(sourcePath)
      if (!validation.ok) return { ok: false, error: validation.reason }

      const next = { ...config, harnessSourcePath: sourcePath }
      const apiKey = typeof patch?.deepseekApiKey === 'string' ? patch.deepseekApiKey.trim() : ''
      const baseUrl = typeof patch?.deepseekBaseUrl === 'string' ? patch.deepseekBaseUrl.trim() : ''
      if (apiKey !== '') next.deepseekApiKey = apiKey
      else delete next.deepseekApiKey
      if (baseUrl !== '') next.deepseekBaseUrl = baseUrl
      else delete next.deepseekBaseUrl

      const sourceChanged = next.harnessSourcePath !== config.harnessSourcePath
      saveConfig(next)

      if (sourceChanged) {
        // Boot against the new source; boot() re-reads the saved config.
        void restart(false)
      } else {
        billing = new BillingService(next)
        if (statusService !== null) statusService.billing = billing
        void pushStatus()
      }
      return { ok: true, sourceChanged }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Ask the user to choose a source directory; resolves undefined on cancel. */
async function pickSourcePath(existing) {
  const result = await dialog.showOpenDialog({
    title: '选择 DeepSeek Harness 源码目录',
    defaultPath: existing,
    buttonLabel: '使用此目录',
    properties: ['openDirectory'],
    message: '请选择 DeepSeek Harness 官方 web 服务源码目录（仓库根目录）。',
  })
  if (result.canceled || result.filePaths.length === 0) return undefined
  return result.filePaths[0]
}

/**
 * Return the configured source path, prompting and persisting a new one on
 * first launch, when the saved path is invalid, or when `forcePick` is set.
 * @returns {Promise<{config: object, sourcePath: string}|undefined>}
 */
async function ensureSourcePath(config, forcePick) {
  const existing = getHarnessSourcePath(config)
  if (!forcePick && existing && validateSourcePath(existing).ok) {
    return { config, sourcePath: existing }
  }
  let candidate = existing
  for (;;) {
    const chosen = await pickSourcePath(candidate)
    if (chosen === undefined) return undefined
    const validation = validateSourcePath(chosen)
    if (validation.ok) {
      const next = setHarnessSourcePath(config, chosen)
      saveConfig(next)
      return { config: next, sourcePath: chosen }
    }
    const { response } = await dialog.showMessageBox({
      type: 'error',
      buttons: ['重新选择', '退出'],
      defaultId: 0,
      cancelId: 1,
      title: '无效的源码目录',
      message: validation.reason,
      detail: chosen,
    })
    if (response !== 0) return undefined
    candidate = chosen
  }
}

/** Install (if needed) and build the source checkout, streaming status lines. */
async function buildSourceWithProgress(sourcePath) {
  showLoading('正在检查依赖…')
  const line = (text) => setStatus(text)
  if (!sourceHasDependencies(sourcePath)) {
    setStatus(`正在安装依赖（${detectPackageManager(sourcePath)} install）…`)
    await installDependencies(sourcePath, line)
  }
  setStatus(`正在构建（${detectPackageManager(sourcePath)} run build）…`)
  await buildSource(sourcePath, line)
}

/** Resolve the built dsh CLI, offering to build the checkout when it is absent. */
async function ensureBuiltBin(sourcePath) {
  const existing = resolveDshBin(sourcePath)
  if (existing) return existing
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['构建', '退出'],
    defaultId: 0,
    cancelId: 1,
    title: '源码尚未构建',
    message: '未找到 apps/cli/lib/bin.js，web 服务源码尚未构建。',
    detail: '将在此目录运行 install（如需要）和 run build。是否现在构建？',
  })
  if (response !== 0) return undefined
  try {
    await buildSourceWithProgress(sourcePath)
  } catch (error) {
    closeLoading()
    dialog.showErrorBox('构建失败', error instanceof Error ? error.message : String(error))
    return undefined
  }
  return resolveDshBin(sourcePath)
}

/**
 * Boot the harness, then open the window.
 * @returns {Promise<boolean>} true on success, false when the user cancelled.
 */
async function boot(forcePick = false) {
  const config = loadConfig()
  billing = new BillingService(config)
  showLoading('正在初始化…')

  const selected = await ensureSourcePath(config, forcePick)
  if (selected === undefined) {
    closeLoading()
    return false
  }

  const bin = await ensureBuiltBin(selected.sourcePath)
  if (bin === undefined) {
    closeLoading()
    return false
  }

  setStatus('正在启动 web 服务…')
  const handle = await startHarness({
    nodeExecutable: 'node',
    dshBin: bin,
    cwd: selected.sourcePath,
    args: buildHarnessArgs(0),
  })
  harness = handle
  // A harness that dies on its own leaves the GUI without a backend: end the app.
  void handle.exited.then(() => { if (!quitting) app.quit() })

  statusService?.stop()
  statusService = new StatusService(handle.url, billing)
  statusService.start()

  closeLoading()
  createMainWindow(handle.url)
  startStatusPush()
  void pushStatus()
  return true
}

/** Report a startup failure and exit, showing the reason in a native dialog. */
function failStartup(error) {
  closeLoading()
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('DeepSeek Harness 启动失败', message)
  app.quit()
}

/** Stop the current harness and boot again, optionally re-picking the source. */
async function restart(forcePick) {
  if (quitting) return
  if (harness !== undefined) {
    await harness.stop()
    harness = undefined
  }
  statusService?.stop()
  statusService = null
  stopStatusPush()
  closeStatusPanel()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  mainWindow = null
  try {
    const ok = await boot(forcePick)
    if (!ok && forcePick) {
      // User cancelled a path change: fall back to the previously saved path.
      await boot(false)
    }
  } catch (error) {
    failStartup(error)
  }
}

/** Install the application menu. */
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '设置…', click: () => { openSettings() } },
        { label: '重启 web 服务', click: () => { void restart(false) } },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'DSH Desktop',
              message: 'DeepSeek Harness 桌面客户端',
              detail: `版本 ${app.getVersion()}`,
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(
  () => {
    registerIpcHandlers()
    buildMenu()
    void boot(false).then((ok) => { if (!ok) app.quit() }).catch(failStartup)
  },
  (error) => { failStartup(error) },
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  statusService?.stop()
  statusService = null
  stopStatusPush()
  closeStatusPanel()
  void (harness === undefined ? Promise.resolve() : harness.stop()).finally(() => { app.quit() })
})
