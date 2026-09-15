# Windows 桌面版

桌面版复用现有 Go 后端与 Vite/React 管理界面，提供本机空间和远程服务器两种运行方式。目前安装包目标为 Windows 10/11 x64。Electron 仅负责窗口、连接设置、下载对话框和本地服务生命周期。

## 使用

首次启动选择「本机空间」，设置至少 12 个字符、最多 72 个 UTF-8 字节的管理员密码，启动后用 `admin` 登录（汉字通常占 3 字节）。密码只通过内置 Go 子进程的环境变量完成首次账号引导，连接配置不会保存明文密码。已有管理员的密码由正常登录/账号管理流程处理。

本机数据默认保存在 `%APPDATA%\chatgpt2api\runtime\data`，网页会话和连接设置保存在 `%APPDATA%\chatgpt2api`。卸载程序默认保留数据；备份时请先退出桌面应用，再复制该目录。删除本地数据库后，下一次启动会重新要求设置管理员密码。

选择「远程服务器」可填写如 `https://canvas.example.com` 或 `http://192.168.1.10:8090` 的服务器地址，沿用远程账号和数据。地址仅包含域名与端口，不接受 URL 内的密码、路径或查询参数。远程模式不会启动本地 Go 服务。不同远程服务采用独立的持久浏览器会话，切换空间不会混用登录信息。

顶部「连接」菜单可以重新打开设置、返回当前服务、在系统浏览器中打开服务。网页导航和登录跳转支持 HTTP/HTTPS，弹出的浏览窗口同样启用沙箱；系统自定义协议不会被网页启动。下载文件时显示保存对话框。连接 Codex 本机桥或局域网服务时，由原生对话框确认本次连接的本地网络权限；读取剪贴板粘贴时采用短时授权。权限仅授予已连接服务的主 frame，不会授予其他来源或 iframe。

本机服务使用独立、未占用的 `127.0.0.1` 临时端口，由桌面进程持有 stdin 管道。健康检查同时验证随机实例标识，避免误连到抢占端口的服务。退出或切换连接前暂停旧窗口交互并等待画布保存，保存失败或 10 秒超时会保留窗口与服务供重试。保存完成后关闭 stdin，等待 Go 完成正常关闭；15 秒后仍未退出才终止子进程，终止失败会保留进程句柄并提示重试。异常退出后可从连接设置重试。

## 源码开发

日常开发仍按仓库规范运行源码。启动前检查项目进程、工作目录、8002/8090 端口、systemd 和容器；已有匹配服务必须复用。

```bash
# 仓库根目录，独立终端；仅在没有现有后端时启动
PORT=8090 go run ./internal

# web/，独立终端；仅在没有现有前端时启动
VITE_BACKEND_URL=http://127.0.0.1:8090 npm run dev -- --host 0.0.0.0 --port 8002

# desktop/
npm ci
npm run dev
```

未打包的 Electron 只验证并复用 `http://127.0.0.1:8002/@vite/client` 和 `http://127.0.0.1:8090/health`。它不会启动 Go、Vite、Docker、预览服务或本地编译二进制。开发会话使用独立的 `chatgpt2api-desktop-development` 配置目录。

## 构建安装包

```bash
# web/
npm run build

# desktop/
npm ci
npm test
npm run build:win
```

`build:win` 先使用 `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags=embed` 生成内置后端，再由 electron-builder 生成 NSIS 安装包。输出位于 `desktop/dist/chatgpt2api-<version>-windows-x64-setup.exe`；只需要解包目录时运行 `npm run pack:win`。建议在 Windows 上构建；Linux 交叉构建完整 NSIS 安装包还需要可运行 32 位 Windows 程序的 Wine。`desktop/bin`、`desktop/dist` 和依赖目录不提交 Git。

Windows 构建工作流 `.github/workflows/windows-desktop.yml` 仅支持手动触发。它构建前端、运行桌面测试、生成安装包与 SHA-256 校验文件，并上传临时 artifact；不会创建 GitHub Release、推送标签或发布更新。安装包当前未签名，Windows 无法据此验证发布者；正式分发前需接入项目自己的代码签名。

## 权限边界与验证

只有随应用分发的本地连接设置页带受控 preload。IPC 同时检查发送窗口、主 frame 和精确文件 URL，仅允许读取连接设置和发起连接。业务网页、远程网页及其弹窗都不注入 preload，启用 `contextIsolation`、`sandbox`，关闭 Node、webview 和不安全混合内容。

连接文件只持久化运行方式、服务器地址和本地初始化状态。子进程环境使用白名单并固定本地数据库、根目录及监听地址；不继承宿主的 API 密钥、数据库 URL 或管理员密码。子进程标准输出被消费但不在桌面配置或额外日志中保存。

`npm test` 使用受控子进程替身和临时 HTTP 服务验证单实例启动、stdin 退出、强制终止与重试、退出时的启动取消、健康检查实例校验、开发服务复用、IPC 来源、URL/下载边界、密码字节上限与不落盘，以及退出前等待保存、保存失败与超时。

本轮 Linux Electron 窗口验证已覆盖单实例锁、源码服务复用、本机与远程切换、会话隔离、设置页独占 IPC、禁用隐藏表单字段、切换/返回/重新加载前等待保存、保存失败时保留页面，以及拒绝本机协议。设置页截图保存在 `review/windows-desktop-settings-linux-smoke.png`，安装包的本地验证记录位于 `desktop/dist/verification.json`。该 Linux root 环境仅在 smoke 启动时使用 `--no-sandbox`；产品代码仍启用沙箱，因此这不构成操作系统沙箱验证。Linux 交叉编译与打包也不能代替 Windows 上的安装、首次引导、远程登录、下载和退出验证，Windows 实机结果应在发布前单独记录。
