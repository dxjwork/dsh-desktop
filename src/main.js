/**
 * Electron main entry for the desktop shell. It boots the
 * `deepseek-harness` git submodule's `dsh web` as a child process,
 * waits for its readiness line, and opens one native window over the served
 * GUI. If the submodule has not been pulled yet, it prompts the user to run
 * `git submodule update --init`.
 * @module dsh-desktop/main
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { buildSource, detectPackageManager, installDependencies, sourceHasDependencies } from './build.js'
import { buildHarnessArgs, startHarness } from './harness.js'
import { resolveDshBin, sourceIsBuilt, validateSourcePath } from './source.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** The git submodule that carries the official harness source. */
const SUBMODULE_NAME = 'deepseek-harness'
const LOADING_HTML = join(__dirname, '..', 'renderer', 'loading.html')

/** The running harness, undefined before boot resolves or after a failure. */
let harness
/** True once quitting has begun, so the stop-and-quit path cannot re-enter. */
let quitting = false
let loadingWindow = null
let mainWindow = null

/** Whether two URLs share an origin, for routing external links out of the app. */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
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
 * Create the native window over the ready harness URL. In-app popups stay in
 * the window; cross-origin targets open in the system browser.
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
  window.on('closed', () => { mainWindow = null })
  void window.loadURL(harnessUrl)
  return window
}

/** Candidate project roots: cwd, the app dir, and a walk-up from the asar. */
function resolveProjectRoots() {
  const roots = []
  roots.push(process.cwd())
  roots.push(app.getAppPath())
  let dir = dirname(app.getAppPath())
  for (let i = 0; i < 6; i += 1) {
    roots.push(dir)
    dir = dirname(dir)
  }
  return roots
}

/** The submodule source path, or undefined when it has not been pulled. */
function resolveSubmoduleSource() {
  for (const root of resolveProjectRoots()) {
    const candidate = join(root, SUBMODULE_NAME)
    if (validateSourcePath(candidate).ok) return candidate
  }
  return undefined
}

/** The repo root (the directory carrying .gitmodules), best-effort. */
function resolveProjectRoot() {
  for (const root of resolveProjectRoots()) {
    if (existsSync(join(root, '.gitmodules'))) return root
  }
  return resolveProjectRoots()[0]
}

/** Run `git submodule update --init` in the project root; resolves ok=true on success. */
function runSubmoduleUpdate(projectRoot) {
  return new Promise((resolve) => {
    const child = spawn('git', ['submodule', 'update', '--init'], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stream = (chunk) => {
      const line = chunk.toString().trimEnd()
      if (line.length > 0) setStatus(line.slice(0, 120))
    }
    child.stdout?.on('data', stream)
    child.stderr?.on('data', stream)
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

/**
 * Resolve the submodule source; when it is missing, offer to pull it and retry.
 * @returns {Promise<string | undefined>}
 */
async function ensureSubmoduleSource() {
  const sourcePath = resolveSubmoduleSource()
  setStatus(sourcePath)
  if (sourcePath !== undefined) return sourcePath

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '缺少子模块源码',
    message: '未找到 deepseek-harness 子模块源码。',
    detail: '请先拉取子模块源码（在项目根目录）：\n\n  git submodule update --init\n\n也可点击下方按钮由本客户端代为执行。',
    buttons: ['执行拉取', '退出'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return undefined

  setStatus('正在拉取子模块源码（git submodule update --init）…')
  const ok = await runSubmoduleUpdate(resolveProjectRoot())
  if (!ok) {
    dialog.showErrorBox('拉取子模块失败', 'git submodule update --init 执行失败，请手动在项目根目录运行该命令。')
    return undefined
  }
  return resolveSubmoduleSource()
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
  if (sourceIsBuilt(sourcePath)) return resolveDshBin(sourcePath)
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['构建', '退出'],
    defaultId: 0,
    cancelId: 1,
    title: '源码尚未构建',
    message: '未找到 apps/cli/lib/bin.js 或 apps/web/dist，web 服务源码尚未构建。',
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
async function boot() {
  showLoading('正在定位子模块源码…')

  const sourcePath = await ensureSubmoduleSource()
  if (sourcePath === undefined) {
    closeLoading()
    return false
  }

  const bin = await ensureBuiltBin(sourcePath)
  if (bin === undefined) {
    closeLoading()
    return false
  }

  setStatus('正在启动 web 服务…')
  const handle = await startHarness({
    nodeExecutable: 'node',
    dshBin: bin,
    cwd: sourcePath,
    args: buildHarnessArgs(0),
  })
  harness = handle
  // A harness that dies on its own leaves the GUI without a backend: end the app.
  void handle.exited.then(() => { if (!quitting) app.quit() })

  closeLoading()
  createMainWindow(handle.url)
  return true
}

/** Report a startup failure and exit, showing the reason in a native dialog. */
function failStartup(error) {
  closeLoading()
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('DeepSeek Harness 启动失败', message)
  app.quit()
}

/** Stop the current harness and boot again. */
async function restart() {
  if (quitting) return
  if (harness !== undefined) {
    await harness.stop()
    harness = undefined
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  mainWindow = null
  try {
    await boot()
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
        { label: '重启 web 服务', click: () => { void restart() } },
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
    buildMenu()
    void boot().then((ok) => { if (!ok) app.quit() }).catch(failStartup)
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
  void (harness === undefined ? Promise.resolve() : harness.stop()).finally(() => { app.quit() })
})
