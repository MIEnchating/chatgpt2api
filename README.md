<h1 align="center">云棉</h1>

<p align="center">
  云棉是一个面向自托管场景的 AI 图片创作与管理服务，提供 OpenAI 兼容图片 API、在线创作台、无限画布、跨设备创作历史、图片库、NewAPI 接入、RBAC 权限管理和 Docker 部署能力。
</p>

> [!WARNING]
> 本项目涉及对 ChatGPT 官网文本生成、图片生成、图片编辑等接口的逆向研究，仅供个人学习、技术研究与非商业性技术交流使用。
>
> - 严禁用于商业用途、盈利性使用、批量操作、自动化滥用、规模化调用、倒卖服务或恶意竞争。
> - 严禁用于违反 OpenAI 服务条款、当地法律法规或平台规则的行为。
> - 严禁用于生成、传播或协助生成违法、暴力、色情、未成年人相关内容，以及诈骗、欺诈、骚扰等非法或不当用途。
> - 使用者需自行承担账号受限、临时封禁、永久封禁、数据损失和法律责任等全部风险。
> - 使用本项目即表示你已理解并同意本声明；因滥用、违规或违法使用造成的后果均由使用者自行承担。

> [!CAUTION]
> 公网部署时请务必添加外部访问控制，不要暴露敏感配置、账号 Token、数据库连接串或管理端入口，并保持部署及时更新。

## 目录

- [快速入口](#快速入口)
- [项目能力](#项目能力)
- [快速部署](#快速部署)
- [升级说明](#升级说明)
- [配置说明](#配置说明)
- [本地开发](#本地开发)
- [发布流程](#发布流程)
- [API 接入](#api-接入)
- [技术研究文档](#技术研究文档)

## 快速入口

| 目标 | 入口 |
| --- | --- |
| 立即部署服务 | [快速部署](#快速部署) |
| 配置管理员、代理、并发、存储 | [配置说明](#配置说明) |
| 创建 API Token 并调用接口 | [API 接入](#api-接入) |
| 查看生图参数、异步任务和错误码 | [生图接口文档](./docs/image-generation-api.md) |
| 本地改代码和验证构建 | [本地开发](#本地开发) |
| 升级 Docker 镜像或 Release 二进制 | [升级说明](#升级说明) |
| ChatGPT 官网生图协议研究 | [技术研究文档](#技术研究文档) / [jshook 索引](./jshook/README.md) |

## 项目能力

### 后端服务

- Go 单体服务，容器内启动 `/app/chatgpt2api`。
- 前端构建产物嵌入 Go 二进制，由 Go 服务直接托管。
- 支持 Docker / Docker Compose 部署。
- 支持 SQLite、PostgreSQL 和 MySQL 存储后端。
- 支持全局 HTTP / HTTPS / SOCKS5 / SOCKS5H 代理。
- 支持 GitHub Actions 自动测试，并在推送稳定版本标签时发布 Docker Hub 多架构镜像。

### 管理端

- React 19 + Vite 管理端。
- 登录页、创作台、无限画布、图片库、号池管理、用户管理、角色权限、日志管理和设置页。
- 登录只保留内置管理员和 NewAPI 普通用户；NewAPI 数据库只读，不在本系统写入用户、Key 或令牌。
- 普通用户按本人可用的 NewAPI Key 名称选择令牌；切换 Key 后，新请求按当前选择精确读取对应密钥。
- 首次启动自动初始化管理员；未配置密码时会生成一次性管理员密码并输出到启动日志。
- 内置 RBAC，统一管理菜单权限和 API 权限。
- 支持个人 API 令牌管理。
- 支持管理员发布系统公告，用户通过通知铃铛查看，并可关闭当日或永久关闭弹窗提醒。
- 支持管理端修改网站名称、图片访问地址、API 访问地址，以及上传自定义网站图标。

### 创作与兼容接口

- OpenAI 兼容图片生成接口：`POST /v1/images/generations`。
- OpenAI 兼容图片编辑接口：`POST /v1/images/edits`。
- 异步创作任务资源：`/api/creation-tasks`。
- 支持 `gpt-image-2`、`codex-gpt-image-2` 和 `auto` 图片任务模型。
- 支持流式图片生成和渐进预览；部分渠道只返回最终图片，特定上游流式解析错误会自动非流式重试一次。
- 创作台历史保存在服务端数据库，同一用户登录不同设备后可以继续查看；图生图参考图保存在服务端受保护目录。
- 无限画布支持服务端项目存储、想法/图片/生成配置节点、节点连线、批量生成、局部编辑、裁剪、多角度、导入导出和图片库同步。

### 图片与数据治理

- 生成结果、缩略图、元数据、结果关联参考图和创作台会话参考图均由服务端统一管理。
- 图片库原图可以保存在本地或 S3 兼容对象存储；对象存储模式适用于 AWS S3、Cloudflare R2、MinIO 和提供 S3 API 的服务。
- 对象存储 Bucket 应设为私有，浏览器仍通过云棉 `/images/...` 鉴权地址读取，不会获得 Bucket 直链。
- 保留天数清理会删除过期私有生成结果及其关联文件，也会删除过期会话参考图；历史对话文字、参数和任务元数据仍保留。
- 总容量限制按治理页口径统计生成原图、缩略图、元数据和创作台会话参考图；清理生成原图时会同时删除其关联参考图。
- 公开图片默认不参与普通保留天数和容量清理；管理员执行清理时可以明确选择包含公开图片。
- 无限画布上传图片和生成结果会进入图片库，因此遵循图片库的可见性与清理策略。

### 账号池与导入

- 支持账号可用性、邮箱、类型、额度、恢复时间刷新。
- 支持轮询可用账号执行图片生成和图片编辑。
- 支持 Token 失效后自动剔除无效账号。
- 支持账号搜索、筛选、批量刷新、导出、编辑和清理。
- 支持本地 CPA JSON 文件导入、远程 CPA 服务器导入、Sub2API 服务器导入和 access token 直接导入。

## 快速部署

### 1. 获取部署文件

```bash
git clone https://github.com/MIEnchating/chatgpt2api.git
cd chatgpt2api
cp .env.example .env
```

编辑 `.env`。至少确认管理员、外部地址和 NewAPI 接入配置：

```env
CHATGPT2API_ADMIN_USERNAME=admin
CHATGPT2API_ADMIN_PASSWORD=change_me_please
CHATGPT2API_BASE_URL=https://image.example.com
CHATGPT2API_RELAY_BASE_URL=https://api.example.com
CHATGPT2API_NEWAPI_DATABASE_URL=postgresql://readonly:password@postgres:5432/new-api?sslmode=disable
CHATGPT2API_NEWAPI_TOKEN_GROUP=gpt-image-2
```

如果不设置 `CHATGPT2API_ADMIN_PASSWORD`，服务首次启动会生成一次性管理员密码并输出到容器日志。

`CHATGPT2API_NEWAPI_DATABASE_URL` 应使用只有 `SELECT` 权限的只读数据库账号。云棉通过它校验普通用户并读取该用户可用的 NewAPI Key；所有 AI 请求再发送到 `CHATGPT2API_RELAY_BASE_URL`，不会向 NewAPI 数据库写入数据。

### 2. 启动服务

```bash
docker compose pull
docker compose up -d
```

默认 Compose 配置：

- 镜像：Docker Hub 的 `mienvirtuoso/chatgpt2api:latest`
- 端口：默认不对外暴露端口
- 数据目录：`./data:/app/data`
- 环境文件：`./.env:/app/.env`
- Docker 网络：`${CHATGPT2API_DOCKER_NETWORK:-newapi_default}`
- 重启策略：`restart: unless-stopped`

反向代理目标：

```text
http://chatgpt2api:80
```

查看日志（需要在仓库根目录执行）：

```bash
docker compose logs -f chatgpt2api
```

查看自动生成的管理员密码（需要在仓库根目录执行）：

```bash
docker compose logs chatgpt2api | grep "bootstrap admin password generated"
```

日志行格式：

```text
bootstrap admin password generated: username=admin password=生成的密码
```

<details>
<summary>PowerShell、容器日志和查不到密码时的处理方式</summary>

Windows PowerShell：

```powershell
docker compose logs chatgpt2api | Select-String "bootstrap admin password generated"
```

默认容器名方式：

```bash
docker logs chatgpt2api 2>&1 | grep "bootstrap admin password generated"
```

如果提示 `no configuration file provided: not found`，说明当前命令没有在仓库根目录执行。先进入仓库根目录再执行 `docker compose logs chatgpt2api`，或直接使用上面的 `docker logs chatgpt2api ...` 命令。

如果查不到日志，先确认本地 `.env` 是否已经设置了固定密码：

```bash
grep -n "^CHATGPT2API_ADMIN_PASSWORD=" .env
```

不要使用会打印容器全部环境变量的排查命令；它可能同时暴露数据库连接串、上游 Token 和其他敏感配置。

如果已经设置了 `CHATGPT2API_ADMIN_PASSWORD`，服务会直接使用该值作为初始管理员密码，不会生成密码，也不会输出 `bootstrap admin password generated` 日志。自动生成的密码只会在首次创建管理员账号时输出一次；如果管理员账号已经存在，重新设置 `.env` 里的 `CHATGPT2API_ADMIN_PASSWORD` 不会覆盖现有管理员密码。容器日志被清理后，明文密码无法从已保存的 bcrypt 哈希中反查。

</details>

<details>
<summary>重置本地管理员密码</summary>

默认 SQLite 部署可按下面步骤重置本地登录账号数据。该操作会删除本地后台登录用户（包括管理员和普通本地用户），但不会删除账号池数据；执行前会先备份 `data` 目录。

```bash
cd ~/chatgpt2api
# 编辑 .env，设置一个新的已知管理员密码：
# CHATGPT2API_ADMIN_PASSWORD=your_new_password

docker compose down
cp -a data "data.bak.$(date +%Y%m%d-%H%M%S)"
python3 - <<'PY'
import sqlite3
from pathlib import Path

db = Path("data/chatgpt2api.db")
if not db.exists():
    raise SystemExit(f"{db} not found")

con = sqlite3.connect(db)
cur = con.execute("DELETE FROM json_documents WHERE name = ?", ("auth_users.json",))
con.commit()
print(f"removed auth_users.json rows: {cur.rowcount}")
con.close()
PY
docker compose up -d
```

</details>

## 升级说明

### Docker 部署升级

```bash
git pull --ff-only
docker compose pull
docker compose up -d
```

生产环境建议在 `.env` 中固定镜像版本，例如 `mienvirtuoso/chatgpt2api:1.3.10`。Git 标签使用 `v1.3.10`，Docker Hub 镜像标签使用不带 `v` 的 `1.3.10`。升级时先修改 `CHATGPT2API_IMAGE`，再执行上面的拉取和启动命令。

### 源码部署升级

源码部署请使用 Git 和本地构建流程：

```bash
git pull
bun install --cwd web --frozen-lockfile
bun --cwd web run build
go test ./...
go build -tags=embed -o chatgpt2api ./internal
```

## 配置说明

运行时配置统一写入 `.env`。容器部署时，平台环境变量也可以覆盖 `.env` 中的同名变量。

### 基础配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHATGPT2API_ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `CHATGPT2API_ADMIN_PASSWORD` | 空 | 初始管理员密码；为空时首次启动自动生成一次性密码 |
| `CHATGPT2API_BASE_URL` | `https://image.yunmian.tech` | 图片访问地址，用于生成图片 URL 和 OAuth 回调地址 |
| `CHATGPT2API_APP_TITLE` | `云棉` | 网站名称，可在管理端设置中修改 |
| `CHATGPT2API_SITE_ICON_URL` | 空 | 网站图标 URL，也可以在管理端上传 |
| `CHATGPT2API_RELAY_BASE_URL` | `https://www.yunmian.tech` | API 访问地址，即 NewAPI 服务地址，可在管理端设置中修改 |
| `CHATGPT2API_NEWAPI_DATABASE_URL` | 空 | NewAPI 数据库只读连接，用于普通用户登录并读取本人可用 Key 的名称和密钥；请使用只有 `SELECT` 权限的账号 |
| `CHATGPT2API_NEWAPI_TOKEN_GROUP` | 空 | 用户尚未选择 Key 名称时的默认分组偏好；实际请求按当前用户选择的 Key 名称精确读取对应密钥 |
| `CHATGPT2API_PROXY` | 空 | 全局代理，支持 `http`、`https`、`socks5`、`socks5h` |
| `CHATGPT2API_IMAGE_MODELS` | `gpt-image-2` | 管理端图片模型列表，多个值用逗号分隔；第一项作为默认模型 |
| `CHATGPT2API_REFRESH_ACCOUNT_INTERVAL_MINUTE` | `5` | 限流账号检查间隔，单位分钟 |
| `CHATGPT2API_IMAGE_TASK_TIMEOUT_SECONDS` | `300` | 图片任务超时时间，单位秒 |
| `CHATGPT2API_USER_DEFAULT_CONCURRENT_LIMIT` | `0` | 普通用户默认创作并发额度；图片生成/编辑按请求张数计入；`0` 表示不限制 |
| `CHATGPT2API_USER_DEFAULT_RPM_LIMIT` | `0` | 普通用户默认创作任务 RPM 限制，`0` 表示不限制 |
| `CHATGPT2API_IMAGE_RETENTION_DAYS` | `30` | 生成图片及会话参考图保留天数；过期文件清理后仍保留历史文字、参数和任务元数据 |
| `CHATGPT2API_IMAGE_STORAGE_LIMIT_MB` | `0` | 图片治理总容量上限，统计生成原图、缩略图、元数据和会话参考图；单位 MB，`0` 表示不按容量自动清理 |
| `CHATGPT2API_IMAGE_STORAGE_BACKEND` | `local` | 图片原图存储后端，可选 `local` 或 `s3`；也可以在管理端在线修改 |
| `CHATGPT2API_S3_ENDPOINT` | 空 | S3 兼容服务地址，只能包含协议和主机，例如 R2 或 MinIO Endpoint |
| `CHATGPT2API_S3_REGION` | 空 | S3 Region；Cloudflare R2 使用 `auto`，MinIO 通常可留空 |
| `CHATGPT2API_S3_BUCKET` | 空 | 已创建的私有 Bucket 名称 |
| `CHATGPT2API_S3_ACCESS_KEY` | 空 | S3 Access Key，仅服务端读取，不通过设置接口返回 |
| `CHATGPT2API_S3_SECRET_KEY` | 空 | S3 Secret Key，仅服务端读取，不通过设置接口返回 |
| `CHATGPT2API_S3_SESSION_TOKEN` | 空 | 可选临时会话令牌，仅服务端读取 |
| `CHATGPT2API_S3_PREFIX` | 空 | 可选对象 Key 前缀，例如 `images` |
| `CHATGPT2API_S3_USE_PATH_STYLE` | `false` | 是否使用 path-style；MinIO 通常设为 `true`，AWS S3/R2 通常为 `false` |
| `CHATGPT2API_LOG_RETENTION_DAYS` | `7` | 业务日志保留天数 |
| `CHATGPT2API_AUTO_REMOVE_INVALID_ACCOUNTS` | `false` | 是否自动移除失效账号 |
| `CHATGPT2API_AUTO_REMOVE_RATE_LIMITED_ACCOUNTS` | `false` | 是否自动移除限流账号 |
| `CHATGPT2API_LOG_LEVELS` | 空 | 日志级别过滤，多个值用逗号分隔：`debug,info,warning,error` |

Cloudflare R2 示例：

```env
CHATGPT2API_IMAGE_STORAGE_BACKEND=s3
CHATGPT2API_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
CHATGPT2API_S3_REGION=auto
CHATGPT2API_S3_BUCKET=cloud-cotton-images
CHATGPT2API_S3_ACCESS_KEY=<access-key>
CHATGPT2API_S3_SECRET_KEY=<secret-key>
CHATGPT2API_S3_PREFIX=images
CHATGPT2API_S3_USE_PATH_STYLE=false
```

MinIO 示例：

```env
CHATGPT2API_IMAGE_STORAGE_BACKEND=s3
CHATGPT2API_S3_ENDPOINT=http://minio:9000
CHATGPT2API_S3_BUCKET=cloud-cotton-images
CHATGPT2API_S3_ACCESS_KEY=<access-key>
CHATGPT2API_S3_SECRET_KEY=<secret-key>
CHATGPT2API_S3_PREFIX=images
CHATGPT2API_S3_USE_PATH_STYLE=true
```

Bucket 需要提前创建并建议保持私有。启用后，正式生图结果、图片库图片、无限画布上传图片及画布工具派生结果会保存到对象存储；缩略图继续作为本地按需缓存。创作台会话中的临时图生图参考附件仍保存在受保护的本地目录，并继续参与统一保留天数和容量治理。

管理端设置页可以在线修改存储后端、Endpoint、Region、Bucket、对象前缀和 Path Style，保存后立即生效。Access Key、Secret Key 和 Session Token 仍只能通过服务端环境变量配置，修改凭据后需要重启服务。切换本地/S3只影响新图片写入位置，历史 S3 图片仍通过保留的读客户端访问；存在历史 S3 图片时，系统会禁止在线修改 Endpoint、Region、Bucket、前缀或 Path Style，避免旧图片失联。系统不会自动迁移已有图片。

### Docker 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHATGPT2API_IMAGE` | `mienvirtuoso/chatgpt2api:latest` | 容器镜像；生产环境建议固定版本标签 |
| `CHATGPT2API_DOCKER_NETWORK` | `newapi_default` | 服务加入的外部 Docker 网络 |
| `TZ` | 容器默认值 | 容器时区，例如 `Asia/Shanghai` |

### 存储后端

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STORAGE_BACKEND` | `sqlite` | 存储后端，可选 `sqlite`、`postgres`、`mysql` |
| `DATABASE_URL` | 自动 | SQLite、PostgreSQL 或 MySQL 连接串 |

这里配置的是业务数据库，与图片原图的 `CHATGPT2API_IMAGE_STORAGE_BACKEND` 相互独立。

SQLite 示例：

```env
STORAGE_BACKEND=sqlite
DATABASE_URL=sqlite:////app/data/chatgpt2api.db
```

PostgreSQL 示例：

```env
STORAGE_BACKEND=postgres
DATABASE_URL=postgresql://user:password@host:5432/chatgpt2api
```

MySQL 示例：

```env
STORAGE_BACKEND=mysql
DATABASE_URL=mysql://user:password@host:3306/chatgpt2api
```

新部署默认使用 SQLite，并自动创建 `data/chatgpt2api.db`。本地 JSON 文件存储后端已移除，`STORAGE_BACKEND=json` 不再支持。

## 本地开发

### 后端

```bash
bun install --cwd web --frozen-lockfile
bun --cwd web run build
go test ./...
go build -tags=embed -o chatgpt2api ./internal
CHATGPT2API_ADMIN_PASSWORD=change_me_please ./chatgpt2api
```

后端单独启动时默认监听：

```text
http://127.0.0.1:8000
```

与 Vite 前端一起开发时，建议把后端放在 `8001`，避免占用前端默认端口 `8000`：

```bash
PORT=8001 ./chatgpt2api
```

### 前端

```bash
cd web
bun install
bun run dev
```

前端开发服务器通过同源代理访问后端，代理目标由 `VITE_BACKEND_URL` 设置。未设置时默认使用：

```text
http://127.0.0.1:8001
```

前端验证命令：

```bash
cd web
bun run lint
bun run build
```

## 发布流程

项目使用 GitHub Actions + GoReleaser 发布。

### CI

`.github/workflows/ci.yml` 在 `main` push 和 pull request 上执行：

- `bun install --frozen-lockfile`
- `bun run lint`
- `bun run test`
- `bun run build`
- `go test ./...`
- `go vet ./...`
- 核心有状态包的 Go race test
- PostgreSQL / MySQL 存储集成测试
- `docker compose config`

### Release

推送 `v*` 标签，或在 Actions 中手动提供标签，会触发 `.github/workflows/release.yml`。流程只接受 `vX.Y.Z` 格式的稳定语义化版本（例如 `v1.2.3`）；预发布标签或其他格式会在构建前被拒绝：

1. 校验标签格式、标签提交与检出的提交一致。
2. 检查并测试前端，再构建 `internal/web/dist`。
3. 上传前端 artifact，并在发布任务中下载到 `internal/web/dist`。
4. 执行 Go 格式、单元测试、vet、race test 和数据库集成测试。
5. GoReleaser 使用 `-tags=embed` 构建 Linux `amd64` / `arm64` 二进制。
6. 生成 GitHub Release archive 和 `checksums.txt`。
7. 使用 `Dockerfile.release` 构建多架构 Docker 镜像。
8. 推送 Docker Hub 镜像。

首次发布前，在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中添加：

| Secret | 内容 |
| --- | --- |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token，不要使用账号密码 |

同时确认 Docker Hub 账号 `mienvirtuoso` 下已创建 `chatgpt2api` 仓库，并且 Access Token 具有推送权限。`DOCKERHUB_TOKEN` 是 Tag 发布的必需配置，缺失时工作流会明确失败，不会跳过 Docker Hub。

发布命令示例：

```bash
git tag -a v1.3.10 -m "Release v1.3.10"
git push origin v1.3.10
```

### Docker 镜像标签

发布到 Docker Hub：

```text
mienvirtuoso/chatgpt2api:<version>
mienvirtuoso/chatgpt2api:latest
mienvirtuoso/chatgpt2api:<major>.<minor>
```

## API 接入

所有受保护的 AI 接口都需要请求头：

```http
Authorization: Bearer <session-or-api-token>
```

后台登录后可以在个人资料或用户管理中创建 API 令牌。

图片生成、图片编辑、异步创作任务、轮询、取消、输出格式、文本型结果和错误码的完整说明见 [生图接口文档](./docs/image-generation-api.md)

### 常用接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/images/generations` | OpenAI 兼容图片生成 |
| `POST` | `/v1/images/edits` | OpenAI 兼容图片编辑 |
| `GET` | `/api/creation-tasks?ids=<id1,id2>` | 查询异步创作任务 |
| `POST` | `/api/creation-tasks/image-generations` | 提交图片生成任务 |
| `POST` | `/api/creation-tasks/image-edits` | 提交图片编辑任务 |
| `POST` | `/api/creation-tasks/{id}/cancel` | 取消任务 |

权限系统中，异步创作任务对应的 API 权限为 `GET /api/creation-tasks` 和 `POST /api/creation-tasks`，并按子路径生效。

### `GET /v1/models`

```bash
curl http://localhost:8000/v1/models \
  -H "Authorization: Bearer <session-or-api-token>"
```

### `POST /v1/images/generations`

```bash
curl http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session-or-api-token>" \
  -d '{
    "model": "auto",
    "prompt": "一只漂浮在太空里的猫",
    "n": 1
  }'
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `model` | 图片模型，支持 `auto`、`gpt-image-2`、`codex-gpt-image-2` |
| `prompt` | 图片生成提示词 |
| `n` | 生成数量，当前限制为 `1-4` |

云棉会读取当前用户选择的 NewAPI Key，并把请求转发到 `CHATGPT2API_RELAY_BASE_URL` 配置的 NewAPI 服务。模型对应的实际渠道、账号能力和最终上游协议由 NewAPI 配置决定；云棉负责参数归一化、鉴权、任务状态、流式事件消费、图片入库和错误展示。

`size` 可以传 `auto`、比例值（如 `1:1`、`16:9`、`9:16`）、分辨率档位（`1080p`、`2k`、`4k`）或显式 `WIDTHxHEIGHT`。服务会先归一化参数再转发，最终输出像素以上游实际返回为准。

### `POST /v1/images/edits`

```bash
curl http://localhost:8000/v1/images/edits \
  -H "Authorization: Bearer <session-or-api-token>" \
  -F "model=auto" \
  -F "prompt=把这张图改成赛博朋克夜景风格" \
  -F "n=1" \
  -F "image=@./input.png"
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `model` | 图片模型，支持 `auto`、`gpt-image-2`、`codex-gpt-image-2` |
| `prompt` | 图片编辑提示词 |
| `n` | 生成数量，当前限制为 `1-4` |
| `image` | 参考图片，使用 multipart/form-data 上传 |

图片编辑同样通过当前用户选择的 NewAPI Key 转发；支持的模型和参数能力取决于对应 NewAPI 渠道。

## 技术研究文档

项目包含对 ChatGPT 官网生图链路的完整逆向分析，详见 `jshook/` 目录：

| 文档 | 说明 |
| --- | --- |
| [jshook 总索引](./jshook/README.md) | 按任务、文档、脚本、响应样本组织的完整入口 |
| [生图链路技术分析](./jshook/docs/ChatGPT-gpt-image-2-generation-pipeline-analysis.md) | 模型路由、Statsig 特性开关、画质控制、改图流程、内部代号等综合分析 |
| [上游 SSE 协议分析](./jshook/docs/upstream-sse-conversation.md) | ChatGPT 官网 SSE 流式响应的格式与事件序列 |
| [API 端点清单](./jshook/docs/api-endpoints.md) | 完整的 API 端点列表与请求/响应结构 |
| [认证 API Schema](./jshook/docs/authenticated-api-schema.md) | 实抓验证的认证生图 API Schema，含 Cloudflare 绕过方案 |
| [请求完成链路](./jshook/docs/request-completion-flow.md) | OV 函数调用链、Callsite ID、SSE 事件序列 |
| [内容类型枚举](./jshook/docs/content-type-enum.md) | 前端 zo 枚举还原 |
| [函数名映射](./jshook/docs/function-mapping.md) | 混淆函数名 → 实际功能对照 |
| [内部代号词典](./jshook/docs/internal-codenames.md) | 后端暗语/代号含义 |
