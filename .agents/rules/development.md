# 构建与本地运行

路径相对于仓库根目录。启动、重启、构建或容器验证前读取。

- `cd web && npm run build` generates the embedded admin UI assets under `internal/web/dist`.
- `go test ./...` runs all backend tests after the frontend assets exist.
- `go build -tags=embed -o chatgpt2api ./internal` builds the service binary with embedded admin UI assets.
- `PORT=8090 go run ./internal` runs the backend from Go source for local development.
- `docker compose pull && docker compose up -d` starts the default containerized deployment using `.env` and the published image.
- `docker build -t chatgpt2api:local .` builds a local image from the current source when needed.
- `cd web && npm run dev` starts the frontend dev server.
- `cd web && npm run build` type-checks and builds the frontend.
- `cd web && npm run lint` runs Oxlint.

### Local Development Runtime Rules

- 日常开发必须运行源码：前端使用 Vite `dev` 模式，后端使用 `go run ./internal`；不得用 Docker/Compose、`vite preview` 或已编译二进制替代开发服务。
- 默认端口固定为前端 `8002`、后端 `8090`。前端通过 `VITE_BACKEND_URL=http://127.0.0.1:8090` 代理后端接口。
- 推荐分别在两个终端启动：`VITE_BACKEND_URL=http://127.0.0.1:8090 npm run dev -- --host 0.0.0.0 --port 8002`（`web/` 目录）和 `PORT=8090 go run ./internal`（仓库根目录）。
- Docker/Compose、`go build -tags=embed` 和 `vite preview` 仅用于部署、发布或构建验证，不作为日常开发启动方式。
- 修改 Go 代码后重启 `go run` 进程；修改前端代码由 Vite HMR 自动更新。提交前仍需按测试规范执行构建、Lint 和 Go 测试。
- 启动开发或验证服务前，必须先检查本项目已有进程、`8002`/`8090` 端口、systemd 服务和 Docker 容器，并确认工作目录与服务用途。
- 已有配置匹配且可用的前端或后端服务必须直接复用；同一项目、同一服务类型和同一端口只允许一个实例，禁止重复启动 `npm run dev` 或 `go run`。
- 不得仅为绕过端口冲突而随意更换端口；确需隔离环境时须明确记录用途、使用未占用端口，并在任务结束后停止临时服务。
- 测试、E2E 和手工验证优先使用现有开发服务。临时服务、浏览器、worker 和编译进程必须由当前任务可追踪并在结束时清理，禁止留下孤儿进程。
- 重启或停止服务前必须核对 PID、工作目录、监听端口及所属 systemd/cgroup，避免误操作正式服务；普通前端修改优先依赖 Vite HMR，不得无故重启已有服务。
