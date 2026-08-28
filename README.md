<h1 align="center">云棉</h1>

<p align="center">
  云棉是一个面向自托管场景的 AI 多媒体创作与管理应用，提供在线创作台、无限画布、Agent、工作流、跨设备创作历史、素材库、NewAPI 接入、RBAC 权限管理和 Docker 部署能力。
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
- [项目架构](#项目架构)
- [快速部署](#快速部署)
- [升级说明](#升级说明)
- [配置说明](#配置说明)
- [本地开发](#本地开发)
- [发布流程](#发布流程)
- [技术研究文档](#技术研究文档)

## 快速入口

| 目标 | 入口 |
| --- | --- |
| 立即部署服务 | [快速部署](#快速部署) |
| 配置管理员、代理、并发、存储 | [配置说明](#配置说明) |
| 查看生图参数、任务状态和错误码 | [生图任务文档](./docs/image-generation-api.md) |
| 查看视频模型参数和上游映射 | [视频生成参数文档](./docs/video-generation-api.md) |
| 查看项目分层与依赖边界 | [架构文档](./docs/architecture.md) |
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
- 登录页、创作台、无限画布、工作流、提示词库、素材库、用户管理、角色权限、日志管理和设置页。
- 登录只保留内置管理员和 NewAPI 普通用户；NewAPI 数据库只读，不在本系统写入用户、Key 或令牌。
- 本地鉴权只使用登录接口签发的 HttpOnly Cookie；不签发个人 API Key，也不接受 `Authorization`、`x-api-key` 等请求头作为内部业务接口凭据。升级时会清除旧版本遗留的本地 API Key 记录。
- 普通用户按本人可用的 NewAPI Key 名称选择令牌；切换 Key 后，新请求按当前选择精确读取对应密钥。
- 首次启动自动初始化管理员；未配置密码时会生成一次性管理员密码并输出到启动日志。
- 内置 RBAC，统一管理菜单和内部业务接口权限。
- 支持管理员发布系统公告，用户通过通知铃铛查看，并可关闭当日或永久关闭弹窗提醒。
- 支持管理端修改网站名称、媒体访问地址、上游模型服务地址，以及上传自定义网站图标。

### 创作能力

- 图片、视频、音频和文本生成请求只由登录后的 Web 创作台、无限画布和工作流通过同源 Cookie 调用 `/api/*` 内部 Web 接口；这些接口不是开放 API，不支持第三方客户端或服务端集成。项目不提供个人 API Token，不接受请求头令牌，不提供匿名文件接口，也不对未知跨域 Origin 返回 CORS 放行头；所有本地 `/v1/*` 路径固定返回 `404`，前端开发服务器也不会代理 `/v1/*`。
- 内部创作任务统一使用异步状态、取消、进度回传和结果入库。
- 默认支持 `gpt-image-2`、Google Gemini 和 Grok 图片模型，也可通过配置添加其他 NewAPI 图片模型。
- Gemini 通过 NewAPI 聊天接口生成并支持参考图编辑；Grok 通过 NewAPI 图片接口生成。
- Gemini 3 图片模型最多支持 14 张参考图；Grok 生图按 xAI 官方协议提供画幅比例、1K/2K 分辨率，Grok 2.0 另支持低/中质量档位。
- 支持流式图片生成和渐进预览；部分渠道只返回最终图片，上游错误会保留原始请求语义并直接返回。
- GPT 图片局部编辑使用官方 multipart `mask` 文件字段；遮罩会校验 PNG、alpha 通道和尺寸，并且不会把原始 base64 写入任务或图片元数据。
- 创作台历史保存在服务端数据库，同一用户登录不同设备后可以继续查看；图生图参考图保存在服务端受保护目录。
- 无限画布支持服务端多项目存储、文本、图片、视频、音频、全景图、导演台和统一生成配置节点，以及节点连线、批量生成、局部编辑、裁剪、多角度、导入导出和素材库同步。
- 画布 Agent 只执行经过白名单、字段类型和数量限制校验的结构化动作，可创建、更新、连接、断开、排列和生成节点；仅在用户明确提出时删除节点，不访问外部网络或执行任意代码。Agent 对话随画布项目保存。
- 全景图节点按 2:1 等距柱状投影生成并提供 3D 球面预览；独立 3D 导演台支持角色、模型、几何体、场景树、变换工具、多机位、全景环境、时间轴、关键帧、截图和 MP4 导出，场景随画布项目保存，截图和视频回传后会创建并自动连接真实画布节点。
- 创意工作流与参考项目一致，面向图片单图和多图系列创作，支持私有/公开模板、运行变量、参考图、运行快照和 Agent 草稿生成；多图系列支持提示词拆分、逐条审核、单张生成、受控并发和批次结果恢复，不提供 DAG 或多媒体步骤编排。

### 图片与数据治理

- 服务器图片图库负责生成原图、缩略图、元数据、结果关联参考图和创作台会话参考图的本地治理。
- 创作台、无限画布、素材库和工作流的持久化文件统一使用 `/api/files` 存储合同；默认写入服务器本机，管理员可配置 S3、Cloudflare R2 或 WebDAV，用户也可在个人资料页配置个人外部存储。
- S3/R2 Bucket 应设为私有；浏览器通过登录态文件接口读取，不会获得存储凭据。
- 保留天数清理会删除过期私有生成结果及其关联文件，也会删除过期会话参考图；历史对话文字、参数和任务元数据仍保留。
- 总容量限制按治理页口径统计生成原图、缩略图、元数据和创作台会话参考图；清理生成原图时会同时删除其关联参考图。
- 公开图片默认不参与普通保留天数和容量清理；管理员执行清理时可以明确选择包含公开图片。
- 无限画布上传和生成的图片、视频与音频写入统一素材存储，并保存稳定的 `storageKey`；未配置 S3/R2/WebDAV 时使用服务器本机 `data/storage_files`，不在浏览器 IndexedDB 中保存媒体文件。
- 外部存储支持真实容量统计、管理员手动统计和 Cron 定时统计；服务器本机素材容量可单独手动统计。

## 项目架构

本项目借鉴 `tigerowo/infinite-canvas` 的职责分层，但保留现有 Go 单体、统一存储抽象和 Vite 前端，不复制其 Gin/GORM/Next.js 技术栈：

```text
web/src/app/*          页面与业务工作区（创作台、画布、工作流、设置）
web/src/lib/*          前端任务合同、模型能力与请求适配
web/public/director    与画布隔离的 3D 导演台静态应用
internal/httpapi       登录态 HTTP 边界、RBAC、参数校验与上游编排
internal/protocol      图片/视频等厂商能力合同和协议映射
internal/service       画布、任务、素材、工作流、存储同步等领域逻辑
internal/storage       SQLite/PostgreSQL/MySQL 持久化抽象
internal/config        环境变量、在线设置和敏感配置边界
```

新增能力不直接堆入路由：工作流、音频任务和远端存储分别拥有独立服务或适配器；创作台与无限画布共享前端生成参数合同；S3/R2、WebDAV 统一通过 `GenericStorageService` 和 `/api/files` 接入。服务器图片图库只负责本地治理，不再维护第二套对象存储配置、远端索引或同步任务。

3D 导演台静态应用取自 MIT 许可的 [`tigerowo/infinite-canvas`](https://github.com/tigerowo/infinite-canvas)，通过同源 iframe 与画布交换受限消息；原始版权与许可文本保存在 `web/public/director/LICENSE`。

## 快速部署

### 1. 获取部署文件

```bash
git clone https://github.com/MIEnchating/chatgpt2api.git
cd chatgpt2api
cp .env.example .env
```

编辑 `.env`。至少确认管理员、外部地址和 NewAPI / Sub2API 接入配置：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_me_please
# 可选：本机文件使用独立域名时设置；留空使用当前站点
# IMAGE_BASE_URL=https://files.example.com
API_BASE_URL=https://api.example.com
DATABASE_URL=postgresql://readonly:password@postgres:5432/relay?sslmode=disable
DATABASE_TYPE=sub2api
```

如果不设置 `ADMIN_PASSWORD`，服务首次启动会生成一次性管理员密码并输出到容器日志。

`DATABASE_URL` 是上游用户数据库的完整连接串快捷配置，也可以改用 `DATABASE_DRIVER/HOST/PORT/NAME/USER/PASSWORD` 拆分字段；`DATABASE_TYPE` 指定其结构，默认 `newapi`，也可设置为 `sub2api`。数据库账号应只有 `SELECT` 权限；云棉通过它校验普通用户并读取余额与本人可用的 Key，不会向上游数据库写入数据。

默认使用最新 NewAPI 已内置、且 xAI 官方仍提供的 `grok-imagine-image`。xAI 官方当前还提供 `grok-imagine-image-quality`（`grok-imagine-image-pro` 是其别名）和 `grok-imagine-image-2.0`；本次核对的 NewAPI `upstream/main`（`47ba9d2`）已内置 `grok-imagine-image-pro`，但尚未内置 2.0 名称。使用 2.0 前需要在 NewAPI 配置自定义模型映射，再把它加入 `IMAGE_MODELS`。云棉不会静默把 2.0 降级成其他模型。

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
- Docker 网络：`${DOCKER_NETWORK:-newapi_default}`
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
grep -n "^ADMIN_PASSWORD=" .env
```

不要使用会打印容器全部环境变量的排查命令；它可能同时暴露数据库连接串、上游 Token 和其他敏感配置。

如果已经设置了 `ADMIN_PASSWORD`，服务会直接使用该值作为初始管理员密码，不会生成密码，也不会输出 `bootstrap admin password generated` 日志。自动生成的密码只会在首次创建管理员账号时输出一次；如果管理员账号已经存在，重新设置 `.env` 里的 `ADMIN_PASSWORD` 不会覆盖现有管理员密码。容器日志被清理后，明文密码无法从已保存的 bcrypt 哈希中反查。

</details>

<details>
<summary>重置本地管理员密码</summary>

默认 SQLite 部署可按下面步骤重置本地登录账号数据。该操作会删除本地后台登录用户（包括管理员和普通本地用户），但不会删除图片、任务等业务数据；执行前会先备份 `data` 目录。

```bash
cd ~/chatgpt2api
# 编辑 .env，设置一个新的已知管理员密码：
# ADMIN_PASSWORD=your_new_password

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

生产环境建议在 `.env` 中固定镜像版本，例如 `mienvirtuoso/chatgpt2api:1.3.10`。Git 标签使用 `v1.3.10`，Docker Hub 镜像标签使用不带 `v` 的 `1.3.10`。升级时先修改 `DOCKER_IMAGE`，再执行上面的拉取和启动命令。

### 源码部署升级

源码部署请使用 Git 和本地构建流程：

```bash
git pull
bun install --cwd web --frozen-lockfile
bun run --cwd web build
go test ./...
go build -tags=embed -o chatgpt2api ./internal
```

## 配置说明

运行时配置统一写入 `.env`。容器部署时，平台环境变量也可以覆盖 `.env` 中的同名变量。

配置只读取本节列出的当前变量名。上游用户数据库使用 `DATABASE_*`，也兼容完整连接串 `DATABASE_URL`；业务数据库固定使用 `STORAGE_DATABASE_URL`，两者不会根据数据库类型或旧变量自动交换用途。旧的 `RELAY_DATABASE_*`、`IMAGE_STORAGE_BACKEND`、`S3_*` 和账号调度变量已不再读取。

### 基础配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `ADMIN_PASSWORD` | 空 | 初始管理员密码；为空时首次启动自动生成一次性密码 |
| `IMAGE_BASE_URL` | 空 | 服务器本机图片、缩略图和参考文件的公开地址覆盖项；留空返回同源相对 URL。外部存储不使用此项 |
| `APP_TITLE` | `云棉` | 网站名称，可在管理端设置中修改 |
| `SITE_ICON_URL` | 空 | 网站图标 URL，也可以在管理端上传 |
| `API_BASE_URL` | `https://www.yunmian.tech` | API 访问地址，即 NewAPI / Sub2API 服务地址，可在管理端设置中修改 |
| `DATABASE_DRIVER` | `postgres` | 上游用户数据库驱动，可选 `sqlite`、`postgres`、`mysql` |
| `DATABASE_HOST` | 空 | 上游用户数据库主机；与下面的端口、库名和账号组成连接配置 |
| `DATABASE_PORT` | 按驱动 | 上游用户数据库端口；PostgreSQL 默认 `5432`，MySQL 默认 `3306` |
| `DATABASE_NAME` | 空 | 上游用户数据库名称；SQLite 时填写数据库文件路径 |
| `DATABASE_USER` | 空 | 上游用户数据库只读账号 |
| `DATABASE_PASSWORD` | 空 | 上游用户数据库只读账号密码；设置接口不会返回明文 |
| `DATABASE_URL` | 空 | 上游用户数据库完整连接串，作为拆分字段未填写完整时的快捷/兼容配置 |
| `DATABASE_TYPE` | `newapi` | 数据库类型，只能是 `newapi` 或 `sub2api`；服务按类型选择对应表结构和认证逻辑 |
| `PROXY` | 空 | 全局代理，支持 `http`、`https`、`socks5`、`socks5h` |
| `IMAGE_MODELS` | `gpt-image-2,gemini-3.1-flash-image,grok-imagine-image` | 图片生成可用模型，创作台、无限画布和工作流共用；多个值用逗号分隔，未指定模型时使用第一项；对应模型需已在 NewAPI / Sub2API 配置可用渠道 |
| `VIDEO_MODELS` | 见 `.env.example` | 视频生成可用模型，创作台和无限画布内部任务共用；多个值用逗号分隔，未指定模型时使用第一项 |
| `TEXT_MODELS` | 见 `.env.example` | 画布 Agent 和工作流 Agent 草稿可用模型；多个值用逗号分隔 |
| `AUDIO_MODELS` | `gpt-4o-mini-tts` | 无限画布音频节点可用模型；多个值用逗号分隔 |
| `CHAT_MODELS` | `gpt-5.5,gpt-5.4` | 服务内部聊天兼容路由使用的模型；不在管理端模型设置中展示 |
| `CREATION_TASK_TIMEOUT_SECONDS` | `300` | 图片、视频、音频和聊天异步创作任务的统一超时时间，单位秒，允许范围 `30-3600` |
| `USER_DEFAULT_CONCURRENT_LIMIT` | `0` | 普通用户默认创作并发额度；每张图片占 1 个额度，视频、音频和聊天任务各占 1 个额度；`0` 表示不限制，管理员不受限制 |
| `USER_DEFAULT_RPM_LIMIT` | `0` | 普通用户默认创作任务提交频率，每次提交计 1 次请求，单位为次/分钟；`0` 表示不限制，管理员不受限制 |
| `IMAGE_RETENTION_DAYS` | `30` | 生成图片及会话参考图保留天数；过期文件清理后仍保留历史文字、参数和任务元数据 |
| `IMAGE_STORAGE_LIMIT_MB` | `0` | 媒体治理中的生成图库容量上限，统计原图、缩略图、元数据和会话参考图；单位 MB，`0` 表示不按容量自动清理 |
| `LOG_RETENTION_DAYS` | `7` | 业务日志保留天数 |
| `DEFAULT_LOG_VIEW` | `meaningful` | 默认日志视图，可选 `all`、`meaningful`、`business` |
| `LOG_LEVELS` | 空 | 需要写入业务日志的级别，多个值用逗号分隔：`debug,info,warning,error`；留空表示记录全部级别 |
| `PROJECT_NAME` | 跟随 `APP_TITLE` | 登录页项目名称 |
| `LOGIN_PAGE_IMAGE_URL` | 空 | 登录页背景图片 URL |
| `LOGIN_PAGE_IMAGE_MODE` | `contain` | 登录页背景模式，可选 `contain`、`cover`、`fill` |
| `LOGIN_PAGE_IMAGE_ZOOM` | `1` | 登录页背景缩放，范围 `1-3` |
| `LOGIN_PAGE_IMAGE_POSITION_X` | `50` | 登录页背景水平位置，范围 `0-100` |
| `LOGIN_PAGE_IMAGE_POSITION_Y` | `50` | 登录页背景垂直位置，范围 `0-100` |
| `PROMPT_PULL_SCHEDULE_ENABLED` | `false` | 是否启用管理端提示词来源页打开期间的定时拉取；不是服务器后台 Cron |
| `PROMPT_PULL_INTERVAL_MINUTES` | `30` | 页面打开期间的提示词来源拉取间隔，可选 `30`、`60`、`360`、`1440` 分钟 |

模型变量都是可选覆盖项。不写入 `.env` 时使用程序内置模型目录；这样升级后可以自动获得新增的内置模型。只有需要限制可选模型时才显式填写。

`OBJECT_STORAGE_SETTINGS` 和 `PROMPT_SOURCES` 是管理端自动写入 `.env` 的内部 JSON 配置。它们可能包含 Provider 凭据，不应手工拼写、复制到 `.env.example` 或提交到版本库。

### 素材存储

素材文件默认写入服务器本机 `data/storage_files`。S3、Cloudflare R2 和 WebDAV 不再通过 `S3_*` 等独立环境变量配置；管理员在“设置 > 存储配置”中维护外部存储、容量上限和自动统计 Cron，普通用户可在个人资料页维护个人 S3/R2 或 WebDAV。S3/R2 Bucket 需要提前创建并建议保持私有，WebDAV 远端目录会在首次写入时创建。

服务器本机素材容量上限也在“设置 > 存储配置”中单独配置，`0` 表示不限制。达到上限后服务会拒绝新的本机素材写入，不会自动删除已有文件。该限制仅针对通过统一素材接口保存的图片、视频和音频；生成图库及其缩略图、参考附件继续使用独立的生成图库容量策略。

容量统计扫描当前外部存储的对象前缀并回写真实占用、最近统计时间和超限状态。管理员可以手动统计，也可以启用 Cron 自动统计。大规模 Bucket 或 WebDAV 目录的全量扫描可能产生请求和流量成本，应按对象数量合理设置 Cron 周期。

### Docker 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCKER_IMAGE` | `mienvirtuoso/chatgpt2api:latest` | 容器镜像；生产环境建议固定版本标签 |
| `DOCKER_NETWORK` | `newapi_default` | 服务加入的外部 Docker 网络 |
| `TZ` | 容器默认值 | 容器时区，例如 `Asia/Shanghai` |
| `PORT` | 镜像为 `80` | HTTP 监听端口；直接运行二进制时默认 `8000` |
| `ROOT_DIR` | 自动查找 | 项目根目录，通常只用于非标准目录结构或本地开发 |

### 存储后端

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STORAGE_BACKEND` | `sqlite` | 存储后端，可选 `sqlite`、`postgres`、`mysql` |
| `STORAGE_DATABASE_URL` | 自动 | SQLite、PostgreSQL 或 MySQL 连接串 |

这里配置的是业务数据库，与“素材存储”中的媒体文件存储相互独立。

SQLite 示例：

```env
STORAGE_BACKEND=sqlite
STORAGE_DATABASE_URL=sqlite:////app/data/chatgpt2api.db
```

PostgreSQL 示例：

```env
STORAGE_BACKEND=postgres
STORAGE_DATABASE_URL=postgresql://user:password@host:5432/chatgpt2api
```

MySQL 示例：

```env
STORAGE_BACKEND=mysql
STORAGE_DATABASE_URL=mysql://user:password@host:3306/chatgpt2api
```

新部署默认使用 SQLite，并自动创建 `data/chatgpt2api.db`。本地 JSON 文件存储后端已移除，`STORAGE_BACKEND=json` 不再支持。

## 本地开发

### 后端

```bash
bun install --cwd web --frozen-lockfile
bun run --cwd web build
go test ./...
go build -tags=embed -o chatgpt2api ./internal
ADMIN_PASSWORD=change_me_please ./chatgpt2api
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

1. 校验标签格式、标签提交与检出的提交一致，并验证 `RELEASE_NOTES.md` 的版本和章节合同。
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

每次发布必须提交根目录 `RELEASE_NOTES.md`。第一行必须是与标签一致的 `# vX.Y.Z`，随后必须按顺序包含且只能包含以下五个二级章节：

1. `## 版本概览`
2. `## 新增功能`
3. `## 功能改进`
4. `## 问题修复`
5. `## 移除与调整`

五个章节都必须有内容；没有对应变更时填写 `- 无`。不允许增加其他 Markdown 标题，文件不得超过 100 KB。CI 检查文件格式，Release 还会检查文件版本与标签完全一致；任一条件不满足都会终止。GitHub Release 正文只读取该文件，GoReleaser 不根据提交记录或标签消息自动生成说明。

发布命令示例：

```bash
git tag -a v2.0.0 -m "v2.0.0"
git push origin v2.0.0
```

### Docker 镜像标签

发布到 Docker Hub：

```text
mienvirtuoso/chatgpt2api:<version>
mienvirtuoso/chatgpt2api:latest
mienvirtuoso/chatgpt2api:<major>.<minor>
```

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
