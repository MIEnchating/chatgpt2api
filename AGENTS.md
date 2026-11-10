# chatgpt2api 开发规范

## 项目与共同规则

- 所有答复使用简体中文；技术术语可保留英文并给出中文解释，代码注释使用英文，配置内容按实际需要选择语言。
- 后端为 Go，入口 `internal/main.go`；前端为 `web/` 下 React 19 / TypeScript / Vite，使用 Tailwind CSS 和 Oxlint。版本及脚本以依赖清单为准。
- 仅针对当前 API 编写代码。除用户明确要求外，不添加兼容层、fallback、shim、feature flag 或多路径处理；优先删除旧实现。
- 保持代码直接可读，使用早返回与明确分支。先检索并复用现有能力，不为缩短调用者添加没有领域含义的单次 helper，不做无关重构。

## 按需阅读

修改或审查前读取对应入口；跨领域任务读取全部相关文档，不默认加载无关细则。

| 任务范围 | 必读入口 |
| --- | --- |
| 前端组件、页面、状态与交互 | [web/AGENTS.md](web/AGENTS.md) |
| 后端路由、服务、存储与协议实现 | [internal/AGENTS.md](internal/AGENTS.md) |
| 启停服务、环境、构建与部署 | [运行规范](.agents/rules/development.md) |
| 上游协议、SSE、sentinel、图像流程或 jshook | [协议研究](.agents/rules/protocol-research.md)，以 [jshook/README.md](jshook/README.md) 为研究索引 |
| 提交、PR、CI、版本与发布 | [发布规范](.agents/rules/release.md) |

## 开发运行

- 日常运行源码：前端 Vite dev 使用 `8002`，后端 `PORT=8090 go run ./internal`；前端通过 `VITE_BACKEND_URL=http://127.0.0.1:8090` 代理。
- 启停前核对进程、目录、端口、systemd/cgroup 和 Docker；复用已有可用服务，不重复启动或为绕过冲突擅自换端口。
- 前端优先 HMR，Go 修改后重启对应开发进程；临时服务与编译进程由当前任务追踪并清理。Docker、二进制和 preview 仅用于部署或构建验证。

## 测试与交付

- 修改 service、protocol、config 或路由行为时，在相关包补充聚焦的 Go 回归测试；先复现缺陷，优先扩展已有测试文件。测试保护行为和契约，不机械复制实现或堆覆盖率。
- 前端变更通过 `cd web && npm run build` 与 `npm run lint`；行为变更运行现有相关测试，不为纯样式布局新增实现细节测试或擅自引入 UI 测试框架。
- `npm run build` 生成 `internal/web/dist` 后可运行 `go test ./...`；按改动范围选择必要检查，复用源码、依赖与环境未变的可靠通过结果，失败或影响不明时扩大范围。
- 测试使用隔离数据与服务；jshook 的认证及外网验证不属于默认测试，只有任务针对该流程时运行。结果明确区分本次执行、缓存复用与未验证项。
- 提交使用 Conventional Commits，PR 写清问题、变更及实际验证；UI 变化按需要提供截图，配置和部署变化说明影响。
- PR 创建、更新、合并运行 CI，关闭未合并跳过，普通分支推送不触发；发布只构建打包，不重复测试或等待 CI。版本及发布说明格式遵循发布规范。

## 安全与文档维护

- 不提交真实密钥、账号令牌、Cookie、代理凭据、数据库 URL 或可复用下载链接。配置从 `.env.example` 开始，设置 `ADMIN_PASSWORD`，公开部署增加外部访问控制。
- 身份、权限、输入与敏感操作校验必须在服务端执行。修改认证或会话流程前阅读适用的 OWASP Authentication / Session Management 指南，验证相关过期、重放、CSRF 和绕过路径。
- 数据库行为变更验证受影响的 SQLite、MySQL、PostgreSQL 路径；迁移验证新库、旧库升级和重复启动，保护已有数据；验证缺失时明确说明限制。
- 根目录只保留共同规则与入口，目标不超过 80 行、8 KB；子目录入口目标不超过 60 行。领域细则写入对应文档，历史记录不持续堆进 AGENTS.md。
- 同一规则保留一个权威正文，其他位置引用。用户确认的规则更新到对应文档；新增领域时补充阅读入口并检查链接。
