# dsh-desktop

DeepSeek Harness 的独立桌面客户端：一个 Electron 外壳，首次启动时让你选择
「官方 web 服务源码」目录，然后在子进程中启动该源码的 `dsh web`，并在原生
窗口中打开它所提供的浏览器 GUI。

外壳**不内嵌** harness：它启动与手动运行相同的 `node apps/cli/lib/bin.js web --port 0`
命令，监听其 stdout 中的 `dsh web: http://127.0.0.1:<port>` 就绪行，再加载该
URL。harness 与窗口共享同一生命周期：关闭窗口会停止 harness，harness 崩溃会
结束应用；跨源链接交给系统浏览器打开。

## 环境要求

- `PATH` 上存在 Node `^22.19 || >=24`（外壳用系统 `node` 启动 harness）。
- 一份**已构建**的 DeepSeek Harness 源码检出（例如 `<你的 deepseek-harness 检出目录>`）：
  需要 `apps/cli/lib/bin.js` 与 `apps/web/dist` 已经构建出来。
- pnpm（工程自身依赖安装使用 pnpm）。

## 安装

```sh
pnpm install
```

Electron 的二进制在 `pnpm install` 的 postinstall 阶段由 `@electron/get` 下载。
本机常见的两个环境问题可按需处理：

- **公司代理 / 自签名 CA 导致 `unable to verify the first certificate`**：
  让 Node 使用系统证书库后再安装（本机已验证需要）：

  ```powershell
  $env:NODE_OPTIONS = "--use-system-ca"
  pnpm install
  ```

- **受限环境无法写 `%LOCALAPPDATA%`**（下载缓存目录被拦）：先把缓存重定向到项目内：

  ```powershell
  $env:electron_config_cache = "<项目目录>\.electron-cache"
  pnpm install
  ```

  两个环境变量可叠加使用。

## 使用

```sh
pnpm start                 # 以开发模式启动外壳（electron .）
node scripts/smoke-start.js <harness源码目录>   # 无 GUI 冒烟测试（指定源码目录）
DSH_SOURCE_PATH=<harness源码目录> pnpm run smoke  # 或通过环境变量指定
```

首次启动会弹出「选择 DeepSeek Harness 源码目录」对话框；选择后路径被持久化到
Electron 的 `userData/config.json`。之后启动直接复用该路径；菜单栏 **文件 → 设置…**
改源码目录 / API Key，**文件 → 重启 web 服务** 重启。

如果所选源码尚未构建（缺少 `apps/cli/lib/bin.js`），外壳会询问是否自动构建，
并在加载窗口里流式显示 `install` / `run build` 的输出。

## 状态胶囊（余额 / Token / 任务 / 子代理）

主窗口右下方有一个**独立的圆角悬浮胶囊**（不遮挡网页），一行显示：

`余额 ¥12.34 · 12.3K 总 · 8.1K 当前 · 2.0K 缓存 · 5.2/s · 任务 2 · 子代理 1 · ⟳ 刷新`

它是主窗口的子窗口（`parent`），随主窗口一起移动/缩放/隐藏——主窗口被其他窗口
盖住或最小化时，胶囊也会一起下去，不会悬浮错位；胶囊空白处可拖动调整位置。

数据来源：

- **余额**：DeepSeek 账户余额（主进程直连 `GET /user/balance`，60s 缓存）。
- **Token 总/当前/缓存/速率**：读纯净源 `session.list` 的 `tokenUsage` 投影，区分
  总消耗、当前会话消耗、缓存命中（token 数 + 占比）、消耗速率（tok/s 或 tok/min）。
- **任务**：运行中的后台任务（订阅纯净源 `/api/events.mux` 的 `session/jobs` 帧）。
- **子代理**：运行中的子代理（读纯净源 `subagent.list`）。

点胶囊上的状态项弹出原生对话框，展示完整明细（余额分项、运行中任务的耗时与子代理
列表）；点 **⟳ 刷新** 立即重新拉取一次最新状态（余额 + token + 任务 + 子代理）。
数据由主进程直接拉取（harness 无 CORS），**不修改纯净源码**。

### 余额的 API Key 配置

余额查询需要 DeepSeek API Key，按以下优先级读取（取到即用）：

1. `config.json` 里的 `deepseekApiKey`（可选，手动写入）。
2. **dsh web 服务自己配置的 key**：`$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`
   （默认，即网页端「模型 / Models」页保存的 key）。
3. 环境变量 `DEEPSEEK_API_KEY`。

Base URL 同理：`deepseekBaseUrl` → 环境变量 `DEEPSEEK_BASE_URL` → 默认
`https://api.deepseek.com`。

例如：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"   # 可选，默认即此值
pnpm start
```

未配置 Key 或端点不可达时，状态栏显示「余额 –」并在详情里说明原因。代理环境下
余额请求同样需要系统 CA，建议连同 `$env:NODE_OPTIONS = "--use-system-ca"` 一起设置
（见上方「安装」一节）。

## 构建可分发产物

```sh
pnpm run build             # electron-builder --dir，产出 release/win-unpacked/
pnpm run dist              # 产出 Windows 安装包（NSIS）与便携版（portable）
```

`build` 只做目录打包（不签名、不下载安装器工具链），适合快速验证；`dist`
需要下载 NSIS 等工具链，首次运行会联网。

## 工作原理

- `src/source.js`：校验源码目录、解析 `apps/cli/lib/bin.js`。
- `src/build.js`：按 lockfile 探测包管理器（pnpm/npm/yarn），提供 install/build。
- `src/harness.ts` 的 JS 移植 `src/harness.js`：spawn `node <bin> web --port 0`，
  解析就绪行，提供 SIGTERM → SIGKILL 递增的 `stop()`。
- `src/main.js`：首次启动选路径、必要时构建、启动 harness、开原生窗口 + 状态栏
  （独立窗口 dock 在下方）、外链转系统浏览器、退出前停止子进程。
- `src/billing.js`：主进程的 DeepSeek 余额查询服务（60s 缓存，失败降级为不可用）。
- `src/status.js`：主进程状态服务，读 `session.list` / `subagent.list` /
  `session/jobs` 汇总余额、Token（总/当前/缓存命中/速率）、任务、子代理。
- `renderer/status.html`：状态栏 UI（余额/Token/任务/子代理 + ⟳ 刷新）。
- `renderer/loading.html`：启动/构建期间的加载窗口。
- `renderer/settings.html`：设置窗口（源码目录 / API Key / Base URL）。
- `scripts/smoke-start.js`：无 GUI 的启动链路冒烟测试。

## 目录结构

```
dsh-desktop/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main.js             # Electron 主进程
│   ├── config.js           # 配置持久化（源码路径）
│   ├── source.js           # 源码目录校验 / dsh bin 解析
│   ├── build.js            # 可选：install + run build
│   ├── harness.js          # dsh web 子进程管理
│   ├── billing.js          # DeepSeek 余额查询（主进程）
│   ├── status.js           # 状态服务（余额/Token/任务/子代理）
│   ├── status-preload.cjs  # 状态栏 IPC 桥
│   └── settings-preload.cjs  # 设置窗口 IPC 桥
├── renderer/
│   ├── status.html         # 状态栏
│   ├── settings.html       # 设置窗口
│   └── loading.html        # 加载窗口
├── scripts/
│   └── smoke-start.js      # 无 GUI 冒烟测试
└── build/                  # 打包资源（icon.ico / icon.png）
```
