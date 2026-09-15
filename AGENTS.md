# Repository Guidelines

## Language Rules

- Always use Simplified Chinese to answer all user questions and requests.
- Technical terms can remain in English, but Chinese explanations must be provided.
- Code comments must be in English.
- Configuration file content language should be determined based on actual needs.

## Coding Principles

**No compatibility layers**
Write for the current API version only. Do not add fallbacks, shims, feature flags, or multi-path handling unless explicitly asked. Prefer deleting old code over guarding it.

## Project Structure & Module Organization

This repository is a Go backend with a Vite/React admin UI. The backend entry point is `internal/main.go`; implementation packages live under `internal/` (`httpapi`, `service`, `protocol`, `storage`, `config`, and helpers). Frontend source is in `web/src/`, with pages under `web/src/app/`, shared UI in `web/src/components/`, API helpers in `web/src/lib/`, and stores in `web/src/store/`. Screenshots are in `assets/`. ChatGPT web reverse-engineering notes live in `jshook/docs/`, with validation scripts and sanitized response samples under `jshook/`.

## Build, Test, and Development Commands

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

## Coding Style & Naming Conventions

Use `gofmt` for Go code and keep package names short, lowercase, and domain-oriented. Place tests beside the code they exercise as `*_test.go`. Frontend code uses TypeScript, React 19, Vite, Oxlint, Tailwind CSS, and shadcn-style components. Prefer kebab-case filenames for React components (`image-composer.tsx`) and PascalCase exports. Reuse helpers from `web/src/lib/` and primitives from `web/src/components/ui/` before adding abstractions.

Admin async creation-task routes use `/api/creation-tasks` as the resource root. Submit task-type-specific work through explicit child resources: `image-generations`, `image-edits`, and `chat-completions`. Do not introduce image-named task aliases or chat routes under image-named resources.

Keep backend dependencies directed from transport to application to persistence: `httpapi` handles routing, authentication, request decoding, and responses; `service` owns business workflows; `storage` owns persistence; `protocol` owns upstream contracts and clients. Split HTTP handlers by business domain instead of adding unrelated handlers to shared route files.

## jshook Reverse-Engineering Notes

Use `jshook/README.md` as the index for ChatGPT web protocol research. Keep endpoint inventories, content-type mappings, request-flow notes, internal codename mappings, and authenticated API schema notes in `jshook/docs/*.md` rather than duplicating them elsewhere.

Use jshook MCP (Chrome CDP + JS Hook + Network Interception) when fresh browser evidence is needed for ChatGPT web behavior, especially request construction, SSE event shape, frontend function mapping, Statsig gates, PoW/sentinel requirements, and image-generation flows. Treat upstream ChatGPT behavior as time-sensitive: verify with a fresh capture or script run before changing backend protocol code based on these notes.

Keep validation scripts in `jshook/scripts/` and raw or reduced response artifacts in `jshook/responses/`. Do not commit live OAuth tokens, cookies, account identifiers, proxy credentials, private prompts, or reusable CDN/download URLs; redact or regenerate fixtures before saving them. jshook scripts may require authenticated local state and external network access, so they are not part of the default `go test ./...` or frontend build verification unless a task explicitly targets those flows.

## Testing Guidelines

Backend coverage is Go test based; add focused unit tests in the relevant `internal/**` package when changing service, protocol, config, or route behavior. Keep test names descriptive, for example `TestRegisterFlow...` or `TestCreationTask...`. Frontend changes should pass `npm run build` and `npm run lint`; add UI tests only if a framework is introduced later.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style subjects such as `feat: ...`, `chore: ...`, `feat(httpapi): ...`, and breaking markers like `feat!:`. Keep subjects concise and scoped to intent. Pull requests should include a summary, verification (`go test ./...`, `npm run build`, screenshots for UI changes), linked issues when applicable, and notes for config or deployment changes.

## Release Notes Guidelines

Every release commit must include a root `RELEASE_NOTES.md`. Its first line must be `# vX.Y.Z`, matching the release tag. It must contain exactly these five H2 sections in order: `版本概览`, `新增功能`, `功能改进`, `问题修复`, and `移除与调整`. Every section must contain content; use `- 无` when no change applies. Do not add other Markdown headings. Validate locally with `bash scripts/validate-release-notes.sh`, or pass the expected tag as its only argument before release.

## Security & Configuration Tips

Do not commit real secrets. Start from `.env.example`, set `ADMIN_PASSWORD`, and keep account tokens, proxy credentials, and database URLs local or in deployment secrets. Public deployments should add external access control.
