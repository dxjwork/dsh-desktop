# dsh-desktop

DeepSeek Harness 的独立桌面客户端：一个 Electron 外壳，直接使用仓库内的
`deepseek-harness-external` git 子模块作为官方 web 服务源码，在子进程中启动
它的 `dsh web`，并在原生窗口中打开它所提供的浏览器 GUI。

外壳**不内嵌** harness：它启动与手动运行相同的 `node apps/cli/lib/bin.js web --port 0`
命令，监听其 stdout 中的 `dsh web: http://127.0.0.1:<port>` 就绪行，再加载该
URL。harness 与窗口共享同一生命周期：关闭窗口会停止 harness，harness 崩溃会
结束应用；跨源链接交给系统浏览器打开。

## 环境要求

- `PATH` 上存在 Node `^22.19 || >=24`（外壳用系统 `node` 启动 harness）。
- `deepseek-harness-external` git 子模块已拉取（`git submodule update --init`），
  且已构建（需要 `apps/cli/lib/bin.js` 与 `apps/web/dist`）。
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

启动时直接使用仓库内的 `deepseek-harness-external` 子模块，不再提示选择目录。
若子模块尚未拉取，会弹窗提示执行 `git submodule update --init`（或点按钮由
客户端代为执行）。菜单栏 **文件 → 重启 web 服务** 可重启。

如果所选源码尚未构建（缺少 `apps/cli/lib/bin.js`），外壳会询问是否自动构建，
并在加载窗口里流式显示 `install` / `run build` 的输出。

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
- `src/main.js`：定位 `deepseek-harness-external` 子模块（缺失时提示执行
  `git submodule update --init`）、必要时构建、启动 harness、开原生窗口、
  外链转系统浏览器、退出前停止子进程。
- `renderer/loading.html`：启动/构建期间的加载窗口。
- `scripts/smoke-start.js`：无 GUI 的启动链路冒烟测试。

## 目录结构

```
dsh-desktop/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main.js             # Electron 主进程
│   ├── source.js           # 源码目录校验 / dsh bin 解析
│   ├── build.js            # 可选：install + run build
│   └── harness.js          # dsh web 子进程管理
├── renderer/
│   └── loading.html        # 加载窗口
├── scripts/
│   └── smoke-start.js      # 无 GUI 冒烟测试
└── build/                  # 打包资源（icon.ico / icon.png）
```
